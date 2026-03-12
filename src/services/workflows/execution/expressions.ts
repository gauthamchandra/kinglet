/**
 * GCP Workflows expression evaluator
 *
 * Parses and evaluates the custom ${...} expression language used by GCP Workflows.
 * This is NOT CEL — it's a custom language with keywords `and`/`or`/`not`,
 * strict typing (no implicit coercion), and no short-circuit evaluation.
 */

import type { VariableScope } from './types.ts';
import { ErrorTag, WorkflowRuntimeError } from './types.ts';

// ── Public API ──

export type StdlibResolver = (name: string, args: unknown[]) => unknown;

/**
 * Evaluate a template value. If it's a string containing ${...}, evaluate the expression.
 * Non-string values pass through unchanged.
 */
export function evaluateTemplate(
  value: unknown,
  scope: VariableScope,
  stdlib: StdlibResolver
): unknown {
  if (typeof value !== 'string') return value;

  // Handle $$ escape → literal $
  const escaped = value.replace(/\$\$/g, '\x00DOLLAR\x00');

  // Check if the entire string is a single ${...} expression
  if (escaped.startsWith('${') && findClosingBrace(escaped, 1) === escaped.length - 1) {
    const expr = escaped.substring(2, escaped.length - 1);

    return evaluateExpression(restoreDollar(expr), scope, stdlib);
  }

  // Not an expression template — restore dollars and return as string
  return restoreDollar(escaped);
}

function restoreDollar(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: sentinel bytes for $$ escape
  return s.replace(/\x00DOLLAR\x00/g, '$');
}

function findClosingBrace(s: string, openIndex: number): number {
  let depth = 0;
  let inString: string | null = null;

  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped char
        continue;
      }

      if (ch === inString) {
        inString = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }

    if (ch === '{') depth++;

    if (ch === '}') {
      depth--;

      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Evaluate a GCP Workflows expression string (without the ${} delimiters).
 */
export function evaluateExpression(
  expr: string,
  scope: VariableScope,
  stdlib: StdlibResolver
): unknown {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens, scope, stdlib);
  const result = parser.parseExpression();

  if (parser.pos < tokens.length) {
    throw new WorkflowRuntimeError(
      `Unexpected token: ${tokens[parser.pos]?.value}`,
      [ErrorTag.ValueError],
      0
    );
  }

  return result;
}

// ── Tokenizer ──

enum TokenType {
  Number = 'Number',
  String = 'String',
  Identifier = 'Identifier',
  Operator = 'Operator',
  Paren = 'Paren',
  Bracket = 'Bracket',
  Dot = 'Dot',
  Comma = 'Comma',
}

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i] as string;

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = '';
      i++;

      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\') {
          i++;
          const esc = expr[i] as string;

          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else if (esc === '\\') str += '\\';
          else if (esc === quote) str += quote;
          else str += esc;
        } else {
          str += expr[i];
        }

        i++;
      }

      i++; // skip closing quote
      tokens.push({ type: TokenType.String, value: str });
      continue;
    }

    // Numbers
    if (
      /[0-9]/.test(ch) ||
      (ch === '-' &&
        i + 1 < expr.length &&
        /[0-9]/.test(expr[i + 1] as string) &&
        (tokens.length === 0 || isOperatorOrOpen(tokens[tokens.length - 1] as Token)))
    ) {
      let num = ch;
      i++;

      while (i < expr.length && /[0-9.]/.test(expr[i] as string)) {
        num += expr[i];
        i++;
      }

      // Don't consume if next char is an identifier char (it's not a negative number but subtraction)
      tokens.push({ type: TokenType.Number, value: num });
      continue;
    }

    // Two-character operators
    if (i + 1 < expr.length) {
      const two = ch + expr[i + 1];

      if (['==', '!=', '>=', '<='].includes(two)) {
        tokens.push({ type: TokenType.Operator, value: two });
        i += 2;
        continue;
      }
    }

    // Single-character operators
    if (['+', '-', '*', '/', '%', '>', '<'].includes(ch)) {
      tokens.push({ type: TokenType.Operator, value: ch });
      i++;
      continue;
    }

    // Parentheses
    if (ch === '(' || ch === ')') {
      tokens.push({ type: TokenType.Paren, value: ch });
      i++;
      continue;
    }

    // Brackets
    if (ch === '[' || ch === ']') {
      tokens.push({ type: TokenType.Bracket, value: ch });
      i++;
      continue;
    }

    // Dot
    if (ch === '.') {
      tokens.push({ type: TokenType.Dot, value: '.' });
      i++;
      continue;
    }

    // Comma
    if (ch === ',') {
      tokens.push({ type: TokenType.Comma, value: ',' });
      i++;
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = ch;
      i++;

      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i] as string)) {
        ident += expr[i];
        i++;
      }

      // Keywords that are operators
      if (ident === 'and' || ident === 'or' || ident === 'not' || ident === 'in') {
        tokens.push({ type: TokenType.Operator, value: ident });
      } else {
        tokens.push({ type: TokenType.Identifier, value: ident });
      }

      continue;
    }

    throw new WorkflowRuntimeError(
      `Unexpected character in expression: '${ch}'`,
      [ErrorTag.ValueError],
      0
    );
  }

  return tokens;
}

function isOperatorOrOpen(token: Token): boolean {
  return (
    token.type === TokenType.Operator ||
    (token.type === TokenType.Paren && token.value === '(') ||
    (token.type === TokenType.Bracket && token.value === '[') ||
    token.type === TokenType.Comma
  );
}

// ── Parser (Pratt-style recursive descent) ──

class Parser {
  pos = 0;

  constructor(
    private tokens: Token[],
    private scope: VariableScope,
    private stdlib: StdlibResolver
  ) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  advance(): Token {
    const t = this.tokens[this.pos];

    if (!t) {
      throw new WorkflowRuntimeError('Unexpected end of expression', [ErrorTag.ValueError], 0);
    }

    this.pos++;

    return t;
  }

  expect(type: TokenType, value?: string): Token {
    const t = this.advance();

    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new WorkflowRuntimeError(
        `Expected ${type}${value ? ` '${value}'` : ''}, got ${t.type} '${t.value}'`,
        [ErrorTag.ValueError],
        0
      );
    }

    return t;
  }

  // ── Precedence climbing ──

  parseExpression(): unknown {
    return this.parseOr();
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    // No short-circuit: always evaluate both sides

    while (this.peek()?.type === TokenType.Operator && this.peek()?.value === 'or') {
      this.advance();
      const right = this.parseAnd();
      left = (left as boolean) || (right as boolean);
    }

    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseNot();

    while (this.peek()?.type === TokenType.Operator && this.peek()?.value === 'and') {
      this.advance();
      const right = this.parseNot();
      left = (left as boolean) && (right as boolean);
    }

    return left;
  }

  private parseNot(): unknown {
    if (this.peek()?.type === TokenType.Operator && this.peek()?.value === 'not') {
      this.advance();

      return !this.parseNot();
    }

    return this.parseIn();
  }

  private parseIn(): unknown {
    const left = this.parseComparison();

    if (this.peek()?.type === TokenType.Operator && this.peek()?.value === 'in') {
      this.advance();
      const right = this.parseComparison();

      if (Array.isArray(right)) {
        return (right as unknown[]).includes(left);
      }

      if (right !== null && typeof right === 'object') {
        return (left as string) in (right as Record<string, unknown>);
      }

      throw new WorkflowRuntimeError(
        'The "in" operator requires a map or list on the right side',
        [ErrorTag.TypeError],
        0
      );
    }

    return left;
  }

  private parseComparison(): unknown {
    let left = this.parseAddSub();

    const compOps = ['==', '!=', '>', '<', '>=', '<='];

    while (this.peek()?.type === TokenType.Operator && compOps.includes(this.peek()?.value ?? '')) {
      const op = this.advance().value;
      const right = this.parseAddSub();

      // Strict type checking for equality
      if (op === '==' || op === '!=') {
        left = this.strictCompare(left, right, op);
      } else {
        left = this.orderedCompare(left, right, op);
      }
    }

    return left;
  }

  private strictCompare(left: unknown, right: unknown, op: string): boolean {
    // null == null is true
    if (left === null && right === null) return op === '==';

    // null compared to non-null raises TypeError
    if (left === null || right === null) {
      throw new WorkflowRuntimeError(
        'Cannot compare null with non-null value',
        [ErrorTag.TypeError],
        0
      );
    }

    // Different types raise TypeError (no implicit coercion)
    if (typeof left !== typeof right) {
      throw new WorkflowRuntimeError(
        `Cannot compare ${typeof left} with ${typeof right}`,
        [ErrorTag.TypeError],
        0
      );
    }

    return op === '==' ? left === right : left !== right;
  }

  private orderedCompare(left: unknown, right: unknown, op: string): boolean {
    if (typeof left !== typeof right) {
      throw new WorkflowRuntimeError(
        `Cannot compare ${typeof left} with ${typeof right}`,
        [ErrorTag.TypeError],
        0
      );
    }

    const l = left as number;
    const r = right as number;

    switch (op) {
      case '>':
        return l > r;
      case '<':
        return l < r;
      case '>=':
        return l >= r;
      case '<=':
        return l <= r;
      default:
        throw new WorkflowRuntimeError(`Unknown operator: ${op}`, [ErrorTag.ValueError], 0);
    }
  }

  private parseAddSub(): unknown {
    let left = this.parseMulDiv();

    while (
      this.peek()?.type === TokenType.Operator &&
      (this.peek()?.value === '+' || this.peek()?.value === '-')
    ) {
      const op = this.advance().value;
      const right = this.parseMulDiv();

      if (op === '+') {
        // String concatenation
        if (typeof left === 'string' || typeof right === 'string') {
          if (typeof left !== 'string' || typeof right !== 'string') {
            throw new WorkflowRuntimeError(
              `Cannot concatenate ${typeof left} with ${typeof right}. Use string() to convert.`,
              [ErrorTag.TypeError],
              0
            );
          }

          left = (left as string) + (right as string);
        } else {
          left = (left as number) + (right as number);
        }
      } else {
        left = (left as number) - (right as number);
      }
    }

    return left;
  }

  private parseMulDiv(): unknown {
    let left = this.parseUnary();

    while (
      this.peek()?.type === TokenType.Operator &&
      (this.peek()?.value === '*' || this.peek()?.value === '/' || this.peek()?.value === '%')
    ) {
      const op = this.advance().value;
      const right = this.parseUnary();

      if (op === '/' || op === '%') {
        if ((right as number) === 0) {
          throw new WorkflowRuntimeError('Division by zero', [ErrorTag.ZeroDivisionError], 0);
        }

        left = op === '/' ? (left as number) / (right as number) : (left as number) % (right as number);
      } else {
        left = (left as number) * (right as number);
      }
    }

    return left;
  }

  private parseUnary(): unknown {
    if (this.peek()?.type === TokenType.Operator && this.peek()?.value === '-') {
      this.advance();

      return -(this.parseUnary() as number);
    }

    return this.parsePostfix();
  }

  private parsePostfix(): unknown {
    let value = this.parsePrimary();

    while (true) {
      const next = this.peek();

      // Dot access: obj.field
      if (next?.type === TokenType.Dot) {
        this.advance();
        const ident = this.expect(TokenType.Identifier);

        // Check for namespaced function call: module.func(...)
        if (this.peek()?.type === TokenType.Paren && this.peek()?.value === '(') {
          // It's a namespaced function like map.get(...)
          // Determine full namespace
          let namespace = '';

          if (typeof value === 'string') {
            namespace = `${value}.${ident.value}`;
          } else {
            // value is a resolved object — this is obj.method() which we don't support
            // Actually for stdlib, the identifier chain should resolve to a function name
            // We need to handle this differently
            // In GCP Workflows, `map.get(...)` means the function `map.get`, not property access
            // So we need to reconstruct the name
            namespace = this.reconstructNamespace(value, ident.value);
          }

          this.advance(); // consume (
          const args = this.parseArgList();
          this.expect(TokenType.Paren, ')');
          value = this.stdlib(namespace, args);
          continue;
        }

        // Regular property access
        if (value === null || value === undefined) {
          throw new WorkflowRuntimeError(
            `Cannot access property '${ident.value}' of null`,
            [ErrorTag.ValueError],
            0
          );
        }

        if (typeof value !== 'object') {
          throw new WorkflowRuntimeError(
            `Cannot access property '${ident.value}' of ${typeof value}`,
            [ErrorTag.TypeError],
            0
          );
        }

        const obj = value as Record<string, unknown>;

        if (!(ident.value in obj)) {
          throw new WorkflowRuntimeError(`Key not found: '${ident.value}'`, [ErrorTag.KeyError], 0);
        }

        value = obj[ident.value];
        continue;
      }

      // Bracket access: obj["key"] or arr[0]
      if (next?.type === TokenType.Bracket && next.value === '[') {
        this.advance();
        const index = this.parseExpression();
        this.expect(TokenType.Bracket, ']');

        if (Array.isArray(value)) {
          const idx = index as number;

          if (idx < 0 || idx >= value.length) {
            throw new WorkflowRuntimeError(
              `Index ${idx} out of range for list of length ${value.length}`,
              [ErrorTag.IndexError],
              0
            );
          }

          value = value[idx];
        } else if (value !== null && typeof value === 'object') {
          const key = String(index);
          const obj = value as Record<string, unknown>;

          if (!(key in obj)) {
            throw new WorkflowRuntimeError(`Key not found: '${key}'`, [ErrorTag.KeyError], 0);
          }

          value = obj[key];
        } else {
          throw new WorkflowRuntimeError(
            `Cannot index into ${typeof value}`,
            [ErrorTag.TypeError],
            0
          );
        }

        continue;
      }

      // Function call: func(...)
      if (next?.type === TokenType.Paren && next.value === '(' && typeof value === 'string') {
        // This case handles when parsePrimary returned an identifier string
        // that hasn't been resolved yet because it might be a function name
        break; // handled in parsePrimary
      }

      break;
    }

    return value;
  }

  private reconstructNamespace(_value: unknown, method: string): string {
    // Walk back through the token stream to find the namespace
    // This is a fallback — in practice, identifiers that are stdlib namespaces
    // are detected in parsePrimary
    return method;
  }

  private parsePrimary(): unknown {
    const token = this.peek();

    if (!token) {
      throw new WorkflowRuntimeError('Unexpected end of expression', [ErrorTag.ValueError], 0);
    }

    // Number literal
    if (token.type === TokenType.Number) {
      this.advance();

      return token.value.includes('.') ? parseFloat(token.value) : parseInt(token.value, 10);
    }

    // String literal
    if (token.type === TokenType.String) {
      this.advance();

      return token.value;
    }

    // Parenthesized expression
    if (token.type === TokenType.Paren && token.value === '(') {
      this.advance();
      const value = this.parseExpression();
      this.expect(TokenType.Paren, ')');

      return value;
    }

    // List literal [...]
    if (token.type === TokenType.Bracket && token.value === '[') {
      this.advance();
      const items: unknown[] = [];

      if (!(this.peek()?.type === TokenType.Bracket && this.peek()?.value === ']')) {
        items.push(this.parseExpression());

        while (this.peek()?.type === TokenType.Comma) {
          this.advance();
          items.push(this.parseExpression());
        }
      }

      this.expect(TokenType.Bracket, ']');

      return items;
    }

    // Identifier (variable, function, keyword)
    if (token.type === TokenType.Identifier) {
      this.advance();
      const name = token.value;

      // Boolean literals
      if (name === 'true' || name === 'True' || name === 'TRUE') return true;
      if (name === 'false' || name === 'False' || name === 'FALSE') return false;
      if (name === 'null') return null;

      // Check if it's a function call: name(...)
      if (this.peek()?.type === TokenType.Paren && this.peek()?.value === '(') {
        this.advance(); // consume (
        const args = this.parseArgList();
        this.expect(TokenType.Paren, ')');

        return this.stdlib(name, args);
      }

      // Check for namespaced identifier: name.something
      // Could be property access on a variable OR a stdlib namespace (map.get, sys.log, etc.)
      if (this.peek()?.type === TokenType.Dot) {
        // Look ahead to see if this is a stdlib function call like map.get(...)
        const savedPos = this.pos;

        this.advance(); // consume dot
        const next = this.peek();

        if (next?.type === TokenType.Identifier) {
          const methodName = next.value;

          this.advance(); // consume method name

          // Check if it's a function call
          if (this.peek()?.type === TokenType.Paren && this.peek()?.value === '(') {
            // Look further for deeper namespaces like text.to_lower(...)
            const fullName = `${name}.${methodName}`;

            this.advance(); // consume (
            const args = this.parseArgList();
            this.expect(TokenType.Paren, ')');

            return this.stdlib(fullName, args);
          }

          // Not a function call — restore and do normal property access
          this.pos = savedPos;
        } else {
          this.pos = savedPos;
        }
      }

      // Regular variable reference
      if (!(name in this.scope.variables)) {
        throw new WorkflowRuntimeError(`Variable not found: '${name}'`, [ErrorTag.KeyError], 0);
      }

      return this.scope.variables[name];
    }

    throw new WorkflowRuntimeError(
      `Unexpected token: ${token.type} '${token.value}'`,
      [ErrorTag.ValueError],
      0
    );
  }

  private parseArgList(): unknown[] {
    const args: unknown[] = [];

    if (this.peek()?.type === TokenType.Paren && this.peek()?.value === ')') {
      return args;
    }

    args.push(this.parseExpression());

    while (this.peek()?.type === TokenType.Comma) {
      this.advance();
      args.push(this.parseExpression());
    }

    return args;
  }
}
