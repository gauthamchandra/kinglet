/**
 * Cloud Armor custom-rules language: a CEL subset with write-time checks
 * that match Compute apply, and evaluate-time execution against request attributes.
 */

import { RE2JS } from 're2js';
import { ipInCidr, isValidCidr } from './request.ts';
import type { ExpressionEvaluation, RequestAttributes } from './types.ts';
import {
  ArmorError,
  MAX_EXPRESSION_CHARS,
  MAX_MATCHES_PER_EXPRESSION,
  MAX_SRC_IP_RANGES,
  MAX_SUBEXPRESSION_CHARS,
  MAX_SUBEXPRESSIONS,
} from './types.ts';

const COMPARISON_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);

const STRING_METHODS = new Set([
  'contains',
  'startsWith',
  'endsWith',
  'matches',
  'lower',
  'upper',
  'base64Decode',
  'urlDecode',
  'urlDecodeUni',
  'utf8ToUnicode',
]);

const KNOWN_FUNCTIONS = new Set([
  'inIpRange',
  'has',
  'int',
  'size',
  'evaluatePreconfiguredWaf',
  'evaluatePreconfiguredExpr',
  'evaluateAddressGroup',
  'evaluateOrganizationAddressGroup',
  'evaluateThreatIntelligence',
  'evaluateAdaptiveProtection',
  'evaluateAdaptiveProtectionAutoDeploy',
]);

const ALWAYS_FALSE_FUNCTIONS = new Set([
  'evaluatePreconfiguredWaf',
  'evaluatePreconfiguredExpr',
  'evaluateAddressGroup',
  'evaluateOrganizationAddressGroup',
  'evaluateThreatIntelligence',
  'evaluateAdaptiveProtection',
  'evaluateAdaptiveProtectionAutoDeploy',
]);

const CEL_MACROS = new Set(['exists', 'exists_one', 'all', 'filter', 'map']);

const ORIGIN_FIELDS = new Set([
  'ip',
  'user_ip',
  'region_code',
  'asn',
  'tls_ja3_fingerprint',
  'tls_ja4_fingerprint',
]);

const REQUEST_FIELDS = new Set(['headers', 'method', 'path', 'query', 'scheme', 'body', 'params']);

type TokKind =
  | 'ident'
  | 'number'
  | 'string'
  | 'true'
  | 'false'
  | 'in'
  | 'eq'
  | 'ne'
  | 'le'
  | 'ge'
  | 'lt'
  | 'gt'
  | 'and'
  | 'or'
  | 'not'
  | 'plus'
  | 'minus'
  | 'dot'
  | 'comma'
  | 'colon'
  | 'lparen'
  | 'rparen'
  | 'lbrack'
  | 'rbrack'
  | 'lbrace'
  | 'rbrace'
  | 'eof';

interface Token {
  kind: TokKind;
  value: string;
  start: number;
  end: number;
}

interface Span {
  start: number;
  end: number;
}

type Ast =
  | ({ kind: 'lit'; value: string | number | boolean } & Span)
  | ({ kind: 'ident'; name: string } & Span)
  | ({ kind: 'member'; object: Ast; name: string } & Span)
  | ({ kind: 'index'; object: Ast; key: Ast } & Span)
  | ({ kind: 'call'; callee: Ast; args: Ast[] } & Span)
  | ({ kind: 'unary'; op: '!' | '-'; arg: Ast } & Span)
  | ({ kind: 'binary'; op: string; left: Ast; right: Ast } & Span)
  | ({ kind: 'list'; elements: Ast[] } & Span)
  | ({ kind: 'map'; entries: Array<{ key: Ast; value: Ast }> } & Span);

class EvalRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalRuntimeError';
  }
}

export function validateExpression(expression: string): void {
  if (expression.length > MAX_EXPRESSION_CHARS) {
    throw new ArmorError(`Expression exceeds maximum of ${MAX_EXPRESSION_CHARS} characters`);
  }

  const ast = parseExpressionAst(expression);

  checkWriteTimeConstraints(ast);
}

export function evaluateExpression(
  expression: string,
  attributes: RequestAttributes
): ExpressionEvaluation {
  try {
    const ast = parseExpressionAst(expression);
    const value = evalAst(ast, toEnv(attributes));

    if (typeof value !== 'boolean') {
      return { ok: false, error: 'expression did not evaluate to a boolean' };
    }

    return { ok: true, matched: value };
  } catch (err) {
    if (err instanceof EvalRuntimeError) {
      return { ok: false, error: err.message };
    }

    if (err instanceof ArmorError) {
      return { ok: false, error: err.message };
    }

    return { ok: false, error: err instanceof Error ? err.message : 'evaluation error' };
  }
}

export function expressionUsesBodyPhase(expression: string): boolean {
  try {
    return astUsesBodyPhase(parseExpressionAst(expression));
  } catch {
    return (
      /\brequest\s*(?:\.\s*(?:body|params)\b|\[\s*['"](?:body|params)['"]\s*\])/.test(expression) ||
      /\bevaluatePreconfigured(Waf|Expr)\s*\(/.test(expression)
    );
  }
}

export function validateSrcIpRanges(ranges: readonly string[]): void {
  if (ranges.length > MAX_SRC_IP_RANGES) {
    throw new ArmorError(`srcIpRanges exceeds maximum of ${MAX_SRC_IP_RANGES}`);
  }

  for (const range of ranges) {
    if (range === '*') {
      continue;
    }

    if (!isValidCidr(range)) {
      throw new ArmorError(`Invalid srcIpRange: ${range}`);
    }
  }
}

export function matchSrcIpRanges(ip: string, ranges: readonly string[]): boolean {
  for (const range of ranges) {
    if (range === '*') {
      return true;
    }

    if (ipInCidr(ip, range)) {
      return true;
    }
  }

  return false;
}

function toEnv(attributes: RequestAttributes): Record<string, unknown> {
  return {
    origin: {
      ip: attributes.origin.ip,
      user_ip: attributes.origin.userIp,
      region_code: attributes.origin.regionCode,
      asn: attributes.origin.asn,
      tls_ja3_fingerprint: attributes.origin.tlsJa3Fingerprint,
      tls_ja4_fingerprint: attributes.origin.tlsJa4Fingerprint,
    },
    request: {
      headers: attributes.request.headers,
      method: attributes.request.method,
      path: attributes.request.path,
      query: attributes.request.query,
      scheme: attributes.request.scheme,
      body: attributes.request.body,
      params: attributes.request.params,
    },
  };
}

function parseExpressionAst(expression: string): Ast {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const ast = parser.parseOr();

  parser.expectEof();

  return ast;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i] ?? '';

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      continue;
    }

    if ((ch === 'R' || ch === 'r') && (source[i + 1] === '"' || source[i + 1] === "'")) {
      const quote = source[i + 1] ?? '"';
      const start = i;
      i += 2;
      let value = '';

      while (i < source.length && source[i] !== quote) {
        value += source[i];
        i++;
      }

      if (i >= source.length) {
        throw new ArmorError('Unterminated raw string literal');
      }

      i++;
      tokens.push({ kind: 'string', value, start, end: i });
      continue;
    }

    if (ch === '"' || ch === "'") {
      tokens.push(readString(source, i));
      i = tokens[tokens.length - 1]?.end ?? i + 1;
      continue;
    }

    if (ch === '&' && source[i + 1] === '&') {
      tokens.push({ kind: 'and', value: '&&', start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (ch === '|' && source[i + 1] === '|') {
      tokens.push({ kind: 'or', value: '||', start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (ch === '=' && source[i + 1] === '=') {
      tokens.push({ kind: 'eq', value: '==', start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (ch === '!' && source[i + 1] === '=') {
      tokens.push({ kind: 'ne', value: '!=', start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (ch === '<' && source[i + 1] === '=') {
      tokens.push({ kind: 'le', value: '<=', start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (ch === '>' && source[i + 1] === '=') {
      tokens.push({ kind: 'ge', value: '>=', start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (ch === '!') {
      tokens.push({ kind: 'not', value: '!', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '<') {
      tokens.push({ kind: 'lt', value: '<', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '>') {
      tokens.push({ kind: 'gt', value: '>', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '+') {
      tokens.push({ kind: 'plus', value: '+', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '-') {
      tokens.push({ kind: 'minus', value: '-', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '.') {
      tokens.push({ kind: 'dot', value: '.', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === ',') {
      tokens.push({ kind: 'comma', value: ',', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === ':') {
      tokens.push({ kind: 'colon', value: ':', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '(') {
      tokens.push({ kind: 'lparen', value: '(', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === ')') {
      tokens.push({ kind: 'rparen', value: ')', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '[') {
      tokens.push({ kind: 'lbrack', value: '[', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === ']') {
      tokens.push({ kind: 'rbrack', value: ']', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '{') {
      tokens.push({ kind: 'lbrace', value: '{', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === '}') {
      tokens.push({ kind: 'rbrace', value: '}', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;

      while (i < source.length && /[0-9.]/.test(source[i] ?? '')) {
        i++;
      }

      tokens.push({ kind: 'number', value: source.substring(start, i), start, end: i });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;

      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] ?? '')) {
        i++;
      }

      const value = source.substring(start, i);
      let kind: TokKind = 'ident';

      if (value === 'true') kind = 'true';
      else if (value === 'false') kind = 'false';
      else if (value === 'in') kind = 'in';

      tokens.push({ kind, value, start, end: i });
      continue;
    }

    throw new ArmorError(`Unexpected character '${ch}' in expression`);
  }

  tokens.push({ kind: 'eof', value: '', start: source.length, end: source.length });

  return tokens;
}

function readString(source: string, start: number): Token {
  const quote = source[start] ?? '"';
  let i = start + 1;
  let value = '';

  while (i < source.length && source[i] !== quote) {
    const ch = source[i] ?? '';

    if (ch === '\\') {
      const esc = source[i + 1] ?? '';

      if (esc === 'n') value += '\n';
      else if (esc === 't') value += '\t';
      else if (esc === '\\') value += '\\';
      else if (esc === "'") value += "'";
      else if (esc === '"') value += '"';
      else value += esc;

      i += 2;
      continue;
    }

    value += ch;
    i++;
  }

  if (i >= source.length) {
    throw new ArmorError('Unterminated string literal');
  }

  i++;

  return { kind: 'string', value, start, end: i };
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  expectEof(): void {
    if (this.peek().kind !== 'eof') {
      throw new ArmorError(`Unexpected token '${this.peek().value}'`);
    }
  }

  parseOr(): Ast {
    let left = this.parseAnd();

    while (this.peek().kind === 'or') {
      this.advance();
      const right = this.parseAnd();

      left = {
        kind: 'binary',
        op: '||',
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }

    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseComparison();

    while (this.peek().kind === 'and') {
      this.advance();
      const right = this.parseComparison();

      left = {
        kind: 'binary',
        op: '&&',
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }

    return left;
  }

  private parseComparison(): Ast {
    const left = this.parseAdd();
    const kind = this.peek().kind;

    if (kind === 'in') {
      throw new ArmorError("undeclared reference to '@in'");
    }

    const op = comparisonOp(kind);

    if (op == null) {
      return left;
    }

    this.advance();
    const right = this.parseAdd();

    return { kind: 'binary', op, left, right, start: left.start, end: right.end };
  }

  private parseAdd(): Ast {
    let left = this.parseUnary();

    while (this.peek().kind === 'plus') {
      this.advance();
      const right = this.parseUnary();

      left = {
        kind: 'binary',
        op: '+',
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }

    return left;
  }

  private parseUnary(): Ast {
    if (this.peek().kind === 'not') {
      const tok = this.advance();
      const arg = this.parseUnary();

      return { kind: 'unary', op: '!', arg, start: tok.start, end: arg.end };
    }

    if (this.peek().kind === 'minus') {
      const tok = this.advance();
      const arg = this.parseUnary();

      return { kind: 'unary', op: '-', arg, start: tok.start, end: arg.end };
    }

    return this.parsePostfix();
  }

  private parsePostfix(): Ast {
    let expr = this.parsePrimary();

    while (true) {
      if (this.peek().kind === 'dot') {
        this.advance();
        const nameTok = this.expect('ident');

        expr = {
          kind: 'member',
          object: expr,
          name: nameTok.value,
          start: expr.start,
          end: nameTok.end,
        };
        continue;
      }

      if (this.peek().kind === 'lbrack') {
        this.advance();
        const key = this.parseOr();
        const close = this.expect('rbrack');

        expr = { kind: 'index', object: expr, key, start: expr.start, end: close.end };
        continue;
      }

      if (this.peek().kind === 'lparen') {
        const args = this.parseArgList();
        const end = this.previous().end;

        expr = { kind: 'call', callee: expr, args, start: expr.start, end };
        continue;
      }

      return expr;
    }
  }

  private parsePrimary(): Ast {
    const tok = this.peek();

    if (tok.kind === 'true' || tok.kind === 'false') {
      this.advance();

      return { kind: 'lit', value: tok.kind === 'true', start: tok.start, end: tok.end };
    }

    if (tok.kind === 'string') {
      this.advance();

      return { kind: 'lit', value: tok.value, start: tok.start, end: tok.end };
    }

    if (tok.kind === 'number') {
      this.advance();

      return {
        kind: 'lit',
        value: tok.value.includes('.')
          ? Number.parseFloat(tok.value)
          : Number.parseInt(tok.value, 10),
        start: tok.start,
        end: tok.end,
      };
    }

    if (tok.kind === 'ident') {
      this.advance();

      return { kind: 'ident', name: tok.value, start: tok.start, end: tok.end };
    }

    if (tok.kind === 'lparen') {
      this.advance();
      const inner = this.parseOr();
      const close = this.expect('rparen');

      return { ...inner, start: tok.start, end: close.end };
    }

    if (tok.kind === 'lbrack') {
      return this.parseList();
    }

    if (tok.kind === 'lbrace') {
      return this.parseMap();
    }

    throw new ArmorError(`Unexpected token '${tok.value}'`);
  }

  private parseArgList(): Ast[] {
    this.expect('lparen');
    const args: Ast[] = [];

    if (this.peek().kind === 'rparen') {
      this.advance();

      return args;
    }

    args.push(this.parseOr());

    while (this.peek().kind === 'comma') {
      this.advance();
      args.push(this.parseOr());
    }

    this.expect('rparen');

    return args;
  }

  private parseList(): Ast {
    const open = this.expect('lbrack');
    const elements: Ast[] = [];

    if (this.peek().kind !== 'rbrack') {
      elements.push(this.parseOr());

      while (this.peek().kind === 'comma') {
        this.advance();
        elements.push(this.parseOr());
      }
    }

    const close = this.expect('rbrack');

    return { kind: 'list', elements, start: open.start, end: close.end };
  }

  private parseMap(): Ast {
    const open = this.expect('lbrace');
    const entries: Array<{ key: Ast; value: Ast }> = [];

    if (this.peek().kind !== 'rbrace') {
      entries.push(this.parseMapEntry());

      while (this.peek().kind === 'comma') {
        this.advance();
        entries.push(this.parseMapEntry());
      }
    }

    const close = this.expect('rbrace');

    return { kind: 'map', entries, start: open.start, end: close.end };
  }

  private parseMapEntry(): { key: Ast; value: Ast } {
    const keyTok = this.peek();
    let key: Ast;

    if (keyTok.kind === 'ident' || keyTok.kind === 'string') {
      this.advance();
      key = {
        kind: 'lit',
        value: keyTok.value,
        start: keyTok.start,
        end: keyTok.end,
      };
    } else {
      key = this.parseOr();
    }

    this.expect('colon');
    const value = this.parseOr();

    return { key, value };
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'eof', value: '', start: 0, end: 0 };
  }

  private previous(): Token {
    return this.tokens[this.pos - 1] ?? { kind: 'eof', value: '', start: 0, end: 0 };
  }

  private advance(): Token {
    const tok = this.peek();

    if (tok.kind !== 'eof') {
      this.pos++;
    }

    return tok;
  }

  private expect(kind: TokKind): Token {
    const tok = this.peek();

    if (tok.kind !== kind) {
      throw new ArmorError(`Expected ${kind} but found '${tok.value}'`);
    }

    return this.advance();
  }
}

function comparisonOp(kind: TokKind): string | null {
  switch (kind) {
    case 'eq':
      return '==';
    case 'ne':
      return '!=';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'le':
      return '<=';
    case 'ge':
      return '>=';
    default:
      return null;
  }
}

function checkWriteTimeConstraints(ast: Ast): void {
  const subSpans: Span[] = [];
  let matchesCount = 0;

  const walk = (node: Ast): void => {
    if (node.kind === 'binary' && COMPARISON_OPS.has(node.op)) {
      subSpans.push({ start: node.start, end: node.end });
    }

    if (node.kind === 'call') {
      subSpans.push({ start: node.start, end: node.end });
      const name = callName(node);

      if (name === 'matches') {
        matchesCount++;
        const pattern = stringLiteralArg(node, 0);

        if (pattern != null) {
          assertRegexAllowed(pattern);
        }
      }

      if (name === 'query_params') {
        throw new ArmorError("undeclared reference to 'query_params'");
      }

      if (name != null && CEL_MACROS.has(name)) {
        throw new ArmorError(`undeclared reference to '${name}'`);
      }

      if (node.callee.kind === 'ident' && !KNOWN_FUNCTIONS.has(node.callee.name)) {
        throw new ArmorError(`undeclared reference to '${node.callee.name}'`);
      }

      if (
        node.callee.kind === 'member' &&
        !STRING_METHODS.has(node.callee.name) &&
        !CEL_MACROS.has(node.callee.name)
      ) {
        throw new ArmorError(`undeclared reference to '${node.callee.name}'`);
      }
    }

    if (node.kind === 'ident' && node.name === 'query_params') {
      throw new ArmorError("undeclared reference to 'query_params'");
    }

    if (node.kind === 'member' && isRequestQuery(node.object) && !STRING_METHODS.has(node.name)) {
      throw new ArmorError('request.query is a string');
    }

    if (node.kind === 'index' && isRequestQuery(node.object)) {
      throw new ArmorError('request.query is a string');
    }

    if (node.kind === 'member' && isIdent(node.object, 'origin') && !ORIGIN_FIELDS.has(node.name)) {
      throw new ArmorError(`undeclared reference to '${node.name}'`);
    }

    if (
      node.kind === 'member' &&
      isIdent(node.object, 'request') &&
      !REQUEST_FIELDS.has(node.name)
    ) {
      throw new ArmorError(`undeclared reference to '${node.name}'`);
    }

    for (const child of childrenOf(node)) {
      walk(child);
    }
  };

  walk(ast);

  if (subSpans.length > MAX_SUBEXPRESSIONS) {
    throw new ArmorError(
      `Expression count of ${subSpans.length} exceeded maximum of ${MAX_SUBEXPRESSIONS}`
    );
  }

  if (matchesCount > MAX_MATCHES_PER_EXPRESSION) {
    throw new ArmorError('only one matches() call is allowed per expression');
  }

  for (const span of subSpans) {
    if (span.end - span.start > MAX_SUBEXPRESSION_CHARS) {
      throw new ArmorError(
        `Subexpression exceeds maximum of ${MAX_SUBEXPRESSION_CHARS} characters`
      );
    }
  }
}

function childrenOf(node: Ast): Ast[] {
  switch (node.kind) {
    case 'member':
      return [node.object];
    case 'index':
      return [node.object, node.key];
    case 'call':
      return [node.callee, ...node.args];
    case 'unary':
      return [node.arg];
    case 'binary':
      return [node.left, node.right];
    case 'list':
      return node.elements;
    case 'map':
      return node.entries.flatMap(e => [e.key, e.value]);
    default:
      return [];
  }
}

function callName(node: Ast): string | null {
  if (node.kind !== 'call') {
    return null;
  }

  if (node.callee.kind === 'ident') {
    return node.callee.name;
  }

  if (node.callee.kind === 'member') {
    return node.callee.name;
  }

  return null;
}

function stringLiteralArg(node: Ast, index: number): string | null {
  if (node.kind !== 'call') {
    return null;
  }

  const arg = node.args[index];

  if (arg?.kind === 'lit' && typeof arg.value === 'string') {
    return arg.value;
  }

  return null;
}

function isIdent(node: Ast, name: string): boolean {
  return node.kind === 'ident' && node.name === name;
}

function isRequestQuery(node: Ast): boolean {
  return node.kind === 'member' && isIdent(node.object, 'request') && node.name === 'query';
}

function requestFieldName(node: Ast): string | null {
  if (node.kind === 'member' && isIdent(node.object, 'request')) {
    return node.name;
  }

  if (node.kind === 'index' && isIdent(node.object, 'request') && node.key.kind === 'lit') {
    return typeof node.key.value === 'string' ? node.key.value : null;
  }

  return null;
}

function astUsesBodyPhase(node: Ast): boolean {
  const field = requestFieldName(node);

  if (field === 'body' || field === 'params') {
    return true;
  }

  if (node.kind === 'call') {
    const name = callName(node);

    if (name === 'evaluatePreconfiguredWaf' || name === 'evaluatePreconfiguredExpr') {
      return true;
    }
  }

  return childrenOf(node).some(astUsesBodyPhase);
}

function assertRegexAllowed(pattern: string): void {
  if (hasCapturingGroup(pattern)) {
    throw new ArmorError('regular expression capture groups are not allowed; use (?:...) instead');
  }

  try {
    RE2JS.compile(pattern, RE2JS.DISABLE_UNICODE_GROUPS);
  } catch (err) {
    throw new ArmorError(err instanceof Error ? err.message : 'invalid regular expression');
  }
}

function hasCapturingGroup(pattern: string): boolean {
  let i = 0;
  let inClass = false;

  while (i < pattern.length) {
    const ch = pattern[i] ?? '';

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (inClass) {
      if (ch === ']') {
        inClass = false;
      }

      i++;
      continue;
    }

    if (ch === '[') {
      inClass = true;
      i++;
      continue;
    }

    if (ch === '(') {
      const rest = pattern.substring(i + 1);

      if (rest.startsWith('?P<') || rest.startsWith('?<')) {
        return true;
      }

      if (rest.startsWith('?')) {
        i++;
        continue;
      }

      return true;
    }

    i++;
  }

  return false;
}

function evalAst(node: Ast, env: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'lit':
      return node.value;
    case 'ident': {
      if (!Object.hasOwn(env, node.name)) {
        throw new EvalRuntimeError(`undeclared reference to '${node.name}'`);
      }

      return env[node.name];
    }
    case 'member':
      return evalMember(node, env);
    case 'index':
      return evalIndex(node, env);
    case 'call':
      return evalCall(node, env);
    case 'unary': {
      const arg = evalAst(node.arg, env);

      if (node.op === '!') {
        return !asBool(arg);
      }

      if (typeof arg !== 'number') {
        throw new EvalRuntimeError('unary minus requires a number');
      }

      return -arg;
    }
    case 'binary':
      return evalBinary(node, env);
    case 'list':
      return node.elements.map(el => evalAst(el, env));
    case 'map': {
      const out: Record<string, unknown> = {};

      for (const entry of node.entries) {
        out[String(evalAst(entry.key, env))] = evalAst(entry.value, env);
      }

      return out;
    }
    default:
      throw new EvalRuntimeError('unsupported expression');
  }
}

function evalBinary(node: Extract<Ast, { kind: 'binary' }>, env: Record<string, unknown>): unknown {
  if (node.op === '&&') {
    const left = evalAst(node.left, env);

    if (!asBool(left)) {
      return false;
    }

    return asBool(evalAst(node.right, env));
  }

  if (node.op === '||') {
    const left = evalAst(node.left, env);

    if (asBool(left)) {
      return true;
    }

    return asBool(evalAst(node.right, env));
  }

  const left = evalAst(node.left, env);
  const right = evalAst(node.right, env);

  if (node.op === '+') {
    return `${asString(left)}${asString(right)}`;
  }

  if (node.op === '==') {
    return Object.is(left, right) || left === right;
  }

  if (node.op === '!=') {
    return !(Object.is(left, right) || left === right);
  }

  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new EvalRuntimeError(`operator ${node.op} requires numbers`);
  }

  if (node.op === '<') return left < right;
  if (node.op === '>') return left > right;
  if (node.op === '<=') return left <= right;
  if (node.op === '>=') return left >= right;

  throw new EvalRuntimeError(`unsupported operator ${node.op}`);
}

function evalMember(node: Extract<Ast, { kind: 'member' }>, env: Record<string, unknown>): unknown {
  const object = evalAst(node.object, env);

  return lookup(object, node.name);
}

function evalIndex(node: Extract<Ast, { kind: 'index' }>, env: Record<string, unknown>): unknown {
  const object = evalAst(node.object, env);
  const key = evalAst(node.key, env);

  return lookup(object, key);
}

function lookup(object: unknown, key: unknown): unknown {
  if (Array.isArray(object)) {
    const index = typeof key === 'number' ? key : Number.parseInt(String(key), 10);

    if (!Number.isInteger(index) || index < 0 || index >= object.length) {
      throw new EvalRuntimeError(`no such key: '${String(key)}'`);
    }

    return object[index];
  }

  if (object != null && typeof object === 'object') {
    const rec = object as Record<string, unknown>;
    const name = String(key);

    if (!Object.hasOwn(rec, name)) {
      throw new EvalRuntimeError(`no such key: '${name}'`);
    }

    return rec[name];
  }

  throw new EvalRuntimeError(`cannot index '${typeof object}'`);
}

function evalCall(node: Extract<Ast, { kind: 'call' }>, env: Record<string, unknown>): unknown {
  const name = callName(node);

  if (name === 'has') {
    const arg = node.args[0];

    if (arg == null) {
      throw new EvalRuntimeError('has() requires an argument');
    }

    return evalHas(arg, env);
  }

  if (name != null && ALWAYS_FALSE_FUNCTIONS.has(name)) {
    for (const arg of node.args) {
      evalAst(arg, env);
    }

    return false;
  }

  if (name === 'inIpRange') {
    const ip = asString(evalAst(requiredArg(node, 0), env));
    const cidr = asString(evalAst(requiredArg(node, 1), env));

    return ipInCidr(ip, cidr);
  }

  if (name === 'int') {
    return toInt(evalAst(requiredArg(node, 0), env));
  }

  if (name === 'size') {
    return sizeOf(evalAst(requiredArg(node, 0), env));
  }

  if (node.callee.kind !== 'member') {
    throw new EvalRuntimeError(`undeclared reference to '${name ?? 'call'}'`);
  }

  const target = evalAst(node.callee.object, env);
  const targetStr = asString(target);

  switch (name) {
    case 'contains':
      return targetStr.includes(asString(evalAst(requiredArg(node, 0), env)));
    case 'startsWith':
      return targetStr.startsWith(asString(evalAst(requiredArg(node, 0), env)));
    case 'endsWith':
      return targetStr.endsWith(asString(evalAst(requiredArg(node, 0), env)));
    case 'matches': {
      const pattern = asString(evalAst(requiredArg(node, 0), env));

      if (hasCapturingGroup(pattern)) {
        throw new EvalRuntimeError('regular expression capture groups are not allowed');
      }

      try {
        return RE2JS.compile(pattern, RE2JS.DISABLE_UNICODE_GROUPS).test(targetStr);
      } catch (err) {
        throw new EvalRuntimeError(
          err instanceof Error ? err.message : 'invalid regular expression'
        );
      }
    }
    case 'lower':
      return targetStr.toLowerCase();
    case 'upper':
      return targetStr.toUpperCase();
    case 'base64Decode':
      return base64Decode(targetStr);
    case 'urlDecode':
      return urlDecode(targetStr);
    case 'urlDecodeUni':
      return urlDecodeUni(targetStr);
    case 'utf8ToUnicode':
      return utf8ToUnicode(targetStr);
    default:
      throw new EvalRuntimeError(`undeclared reference to '${name ?? 'method'}'`);
  }
}

function evalHas(node: Ast, env: Record<string, unknown>): boolean {
  if (node.kind === 'index') {
    const object = evalAst(node.object, env);
    const key = evalAst(node.key, env);

    return hasKey(object, key);
  }

  if (node.kind === 'member') {
    const object = evalAst(node.object, env);

    return hasKey(object, node.name);
  }

  try {
    evalAst(node, env);

    return true;
  } catch (err) {
    if (err instanceof EvalRuntimeError) {
      return false;
    }

    throw err;
  }
}

function hasKey(object: unknown, key: unknown): boolean {
  if (Array.isArray(object)) {
    const index = typeof key === 'number' ? key : Number.parseInt(String(key), 10);

    return Number.isInteger(index) && index >= 0 && index < object.length;
  }

  if (object != null && typeof object === 'object') {
    return Object.hasOwn(object as Record<string, unknown>, String(key));
  }

  return false;
}

function requiredArg(node: Extract<Ast, { kind: 'call' }>, index: number): Ast {
  const arg = node.args[index];

  if (arg == null) {
    throw new EvalRuntimeError('missing function argument');
  }

  return arg;
}

function asBool(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new EvalRuntimeError('expected boolean');
  }

  return value;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new EvalRuntimeError('expected string');
  }

  return value;
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  throw new EvalRuntimeError('int() requires an integer string');
}

function sizeOf(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }

  if (Array.isArray(value)) {
    return value.length;
  }

  if (value != null && typeof value === 'object') {
    return Object.keys(value).length;
  }

  throw new EvalRuntimeError('size() requires a string, list, or map');
}

function base64Decode(value: string): string {
  const normalized = value.replace(/_/g, '/').replace(/-/g, '+');
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : `${normalized}${'='.repeat(4 - pad)}`;

  try {
    return atob(padded);
  } catch {
    return '';
  }
}

function urlDecode(input: string): string {
  return decodePercent(input, false);
}

function urlDecodeUni(input: string): string {
  return decodePercent(input, true);
}

function decodePercent(input: string, unicode: boolean): string {
  let out = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i] ?? '';

    if (ch === '+') {
      out += ' ';
      i++;
      continue;
    }

    if (unicode && ch === '%' && (input[i + 1] === 'u' || input[i + 1] === 'U')) {
      const hex = input.substring(i + 2, i + 6);

      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
    }

    if (ch === '%' && i + 2 < input.length) {
      const bytes: number[] = [];
      let j = i;

      while (j + 2 < input.length && input[j] === '%') {
        const hex = input.substring(j + 1, j + 3);

        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          break;
        }

        bytes.push(Number.parseInt(hex, 16));
        j += 3;
      }

      if (bytes.length > 0) {
        try {
          out += new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
          i = j;
          continue;
        } catch {
          out += input.substring(i, i + 3);
          i += 3;
          continue;
        }
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function utf8ToUnicode(value: string): string {
  let out = '';

  for (const ch of value) {
    const cp = ch.codePointAt(0);

    if (cp == null) {
      continue;
    }

    if (cp <= 0x7f) {
      out += ch;
      continue;
    }

    out += `%u${cp.toString(16).padStart(4, '0')}`;
  }

  return out;
}
