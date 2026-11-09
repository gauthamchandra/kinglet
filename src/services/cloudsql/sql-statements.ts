/**
 * Recognize a simple-query CREATE DATABASE or DROP DATABASE.
 *
 * <p>PGlite has no CREATE DATABASE, so a statement we recognize never reaches
 * it. The caller turns the result into the admin API's database create or
 * delete for the instance the client connected to. A statement this does not
 * recognize is forwarded unchanged, which is what keeps a second statement in
 * the same query from being swallowed.
 */

import type { SimpleQueryContext } from '@/shared/postgres-data-plane/postgres-wire-server.ts';

const MAX_IDENTIFIER_BYTES = 63;

const IGNORED_OPTIONS = new Set(['OWNER', 'LC_COLLATE', 'LC_CTYPE', 'LOCALE']);

const REJECTED_OPTIONS = new Set([
  'TABLESPACE',
  'STRATEGY',
  'ALLOW_CONNECTIONS',
  'CONNECTION',
  'IS_TEMPLATE',
  'OID',
  'ICU_LOCALE',
  'ICU_RULES',
  'LOCALE_PROVIDER',
  'COLLATION_VERSION',
  'BUILTIN_LOCALE',
]);

const ACCEPTED_ENCODINGS = new Set(['UTF8', 'UTF-8', 'UNICODE']);

export type RecognizedDatabaseStatement =
  | { action: 'forward' }
  | { action: 'error'; sqlState: string; message: string }
  | { action: 'create'; name: string }
  | { action: 'drop'; name: string; ifExists: boolean };

type WordToken = { kind: 'word'; value: string; keyword: string | null };
type Token =
  | WordToken
  | { kind: 'string'; value: string }
  | { kind: 'semicolon' }
  | { kind: 'equals' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const FORWARD: RecognizedDatabaseStatement = { action: 'forward' };

export function recognizeDatabaseStatement(
  sql: string,
  transactionStatus: SimpleQueryContext['transactionStatus']
): RecognizedDatabaseStatement {
  const tokens = tokenize(sql);

  if (!tokens) return FORWARD;

  const body = singleStatement(tokens);

  if (!body) return FORWARD;

  const verb = keywordOf(body[0]);

  if (keywordOf(body[1]) !== 'DATABASE' || (verb !== 'CREATE' && verb !== 'DROP')) return FORWARD;

  const recognized = verb === 'CREATE' ? parseCreate(body.slice(2)) : parseDrop(body.slice(2));

  if (recognized.action === 'forward') return FORWARD;

  if (transactionStatus === 'T') {
    return {
      action: 'error',
      sqlState: '25001',
      message: `${verb} DATABASE cannot run inside a transaction block`,
    };
  }

  if (transactionStatus === 'E') {
    return {
      action: 'error',
      sqlState: '25P02',
      message: 'current transaction is aborted, commands ignored until end of transaction block',
    };
  }

  return recognized;
}

function parseCreate(tokens: Token[]): RecognizedDatabaseStatement {
  const name = wordValue(tokens[0]);

  if (name == null) return FORWARD;

  const invalid = invalidName(name);

  if (invalid) return invalid;

  let index = 1;

  if (keywordOf(tokens[index]) === 'WITH') index += 1;

  while (index < tokens.length) {
    const option = keywordOf(tokens[index]);

    if (!option) return FORWARD;

    index += 1;

    if (REJECTED_OPTIONS.has(option)) {
      return {
        action: 'error',
        sqlState: '0A000',
        message: `option "${option}" is not supported`,
      };
    }

    const value = readValue(tokens, index);

    if (!value) return FORWARD;

    index = value.next;

    if (option === 'ENCODING' && !ACCEPTED_ENCODINGS.has(value.text.toUpperCase())) {
      return {
        action: 'error',
        sqlState: '0A000',
        message: `ENCODING ${value.text} is not supported`,
      };
    }

    if (option === 'TEMPLATE' && value.text.toLowerCase() !== 'template0') {
      return {
        action: 'error',
        sqlState: '0A000',
        message: `TEMPLATE ${value.text} is not supported`,
      };
    }

    if (option !== 'ENCODING' && option !== 'TEMPLATE' && !IGNORED_OPTIONS.has(option)) {
      return FORWARD;
    }
  }

  return { action: 'create', name };
}

function parseDrop(tokens: Token[]): RecognizedDatabaseStatement {
  let index = 0;
  let ifExists = false;

  if (keywordOf(tokens[index]) === 'IF') {
    if (keywordOf(tokens[index + 1]) !== 'EXISTS') return FORWARD;

    ifExists = true;
    index += 2;
  }

  const name = wordValue(tokens[index]);

  if (name == null) return FORWARD;

  const invalid = invalidName(name);

  if (invalid) return invalid;

  const tail = tokens.slice(index + 1);

  if (tail.length === 0) return { action: 'drop', name, ifExists };

  if (!isForceClause(tail)) return FORWARD;

  return {
    action: 'error',
    sqlState: '0A000',
    message: 'DROP DATABASE ... FORCE is not supported',
  };
}

function isForceClause(tokens: Token[]): boolean {
  let index = 0;

  if (keywordOf(tokens[index]) === 'WITH') index += 1;

  return (
    tokens[index]?.kind === 'lparen' &&
    keywordOf(tokens[index + 1]) === 'FORCE' &&
    tokens[index + 2]?.kind === 'rparen' &&
    index + 3 === tokens.length
  );
}

function invalidName(name: string): RecognizedDatabaseStatement | null {
  if (name.length === 0) {
    return { action: 'error', sqlState: '42602', message: 'invalid database name ""' };
  }

  if (new TextEncoder().encode(name).length > MAX_IDENTIFIER_BYTES) {
    return {
      action: 'error',
      sqlState: '42622',
      message: `identifier "${name}" exceeds 63 bytes`,
    };
  }

  return null;
}

function readValue(tokens: Token[], index: number): { text: string; next: number } | null {
  let cursor = index;

  if (tokens[cursor]?.kind === 'equals') cursor += 1;

  const token = tokens[cursor];

  if (!token || (token.kind !== 'word' && token.kind !== 'string')) return null;

  return { text: token.value, next: cursor + 1 };
}

function keywordOf(token: Token | undefined): string | null {
  if (!token || token.kind !== 'word') return null;

  return token.keyword;
}

function wordValue(token: Token | undefined): string | null {
  if (!token || token.kind !== 'word') return null;

  return token.value;
}

/** One statement, or null when a second statement follows the semicolon. */
function singleStatement(tokens: Token[]): Token[] | null {
  const semicolon = tokens.findIndex(token => token.kind === 'semicolon');

  if (semicolon < 0) return tokens;

  if (tokens.slice(semicolon + 1).length > 0) return null;

  return tokens.slice(0, semicolon);
}

function tokenize(sql: string): Token[] | null {
  const tokens: Token[] = [];

  let index = 0;

  while (index < sql.length) {
    const character = sql[index] ?? '';

    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      index += 1;
      continue;
    }

    if (character === '-' && sql[index + 1] === '-') {
      index += 2;

      while (index < sql.length && sql[index] !== '\n') index += 1;

      continue;
    }

    if (character === '/' && sql[index + 1] === '*') {
      const closed = skipBlockComment(sql, index + 2);

      if (closed == null) return null;

      index = closed;
      continue;
    }

    if (character === '"') {
      const quoted = readQuoted(sql, index + 1, '"');

      if (!quoted) return null;

      tokens.push({ kind: 'word', value: quoted.value, keyword: null });
      index = quoted.next;
      continue;
    }

    if (character === "'") {
      const quoted = readQuoted(sql, index + 1, "'");

      if (!quoted) return null;

      tokens.push({ kind: 'string', value: quoted.value });
      index = quoted.next;
      continue;
    }

    if (character === ';') {
      tokens.push({ kind: 'semicolon' });
      index += 1;
      continue;
    }

    if (character === '=') {
      tokens.push({ kind: 'equals' });
      index += 1;
      continue;
    }

    if (character === '(') {
      tokens.push({ kind: 'lparen' });
      index += 1;
      continue;
    }

    if (character === ')') {
      tokens.push({ kind: 'rparen' });
      index += 1;
      continue;
    }

    if (!isIdentifierStart(character)) return null;

    const start = index;

    while (index < sql.length && isIdentifierContinue(sql[index] ?? '')) index += 1;

    const raw = sql.slice(start, index);

    tokens.push({ kind: 'word', value: raw.toLowerCase(), keyword: raw.toUpperCase() });
  }

  return tokens;
}

/** A quoted identifier or string. Doubled quotes are the escape. */
function readQuoted(
  sql: string,
  start: number,
  quote: '"' | "'"
): { value: string; next: number } | null {
  let value = '';
  let index = start;

  while (index < sql.length) {
    if (sql[index] !== quote) {
      value += sql[index];
      index += 1;
      continue;
    }

    if (sql[index + 1] === quote) {
      value += quote;
      index += 2;
      continue;
    }

    return { value, next: index + 1 };
  }

  return null;
}

/**
 * Postgres block comments nest. Stopping at the first star-slash would treat
 * the text after an inner comment as SQL and could drop the wrong database.
 */
function skipBlockComment(sql: string, start: number): number | null {
  let depth = 1;
  let index = start;

  while (index < sql.length && depth > 0) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1;
      index += 2;
      continue;
    }

    if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1;
      index += 2;
      continue;
    }

    index += 1;
  }

  if (depth !== 0) return null;

  return index;
}

function isIdentifierStart(character: string): boolean {
  return (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    character === '_'
  );
}

function isIdentifierContinue(character: string): boolean {
  return (
    isIdentifierStart(character) || (character >= '0' && character <= '9') || character === '$'
  );
}
