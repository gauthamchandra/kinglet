/**
 * Tests for the simple-query CREATE DATABASE / DROP DATABASE recognizer.
 *
 * The recognizer decides whether a lone Query message is one of those
 * statements. Anything it does not recognize must come back unhandled so the
 * wire server forwards the bytes, including a second statement hiding after a
 * quoted semicolon.
 */

import { describe, expect, test } from 'bun:test';
import { recognizeDatabaseStatement } from './sql-statements.ts';

const IDLE = 'I' as const;

describe('recognizeDatabaseStatement', () => {
  test('lowercases an unquoted name and keeps a quoted one', () => {
    expect(recognizeDatabaseStatement('CREATE DATABASE App', IDLE)).toEqual({
      action: 'create',
      name: 'app',
    });
    expect(recognizeDatabaseStatement('CREATE DATABASE "App"', IDLE)).toEqual({
      action: 'create',
      name: 'App',
    });
  });

  test('treats a quoted semicolon as part of the name', () => {
    expect(recognizeDatabaseStatement('CREATE DATABASE "foo;bar"', IDLE)).toEqual({
      action: 'create',
      name: 'foo;bar',
    });
  });

  test('leaves a second statement unhandled', () => {
    expect(recognizeDatabaseStatement('CREATE DATABASE foo; DROP TABLE users', IDLE)).toEqual({
      action: 'forward',
    });
  });

  test('accepts a trailing semicolon, comments, and the ignored option list', () => {
    const statement = `
      -- rails db:create
      CREATE DATABASE app WITH OWNER = postgres
        ENCODING = 'unicode' TEMPLATE = template0 LC_COLLATE = 'C' LC_CTYPE = 'C' LOCALE = 'C';
    `;

    expect(recognizeDatabaseStatement(statement, IDLE)).toEqual({
      action: 'create',
      name: 'app',
    });
  });

  test('accepts UTF8 and UTF-8 encodings and rejects any other', () => {
    expect(recognizeDatabaseStatement("CREATE DATABASE app ENCODING 'UTF8'", IDLE)).toEqual({
      action: 'create',
      name: 'app',
    });
    expect(recognizeDatabaseStatement('CREATE DATABASE app ENCODING = "UTF-8"', IDLE)).toEqual({
      action: 'create',
      name: 'app',
    });
    expect(recognizeDatabaseStatement("CREATE DATABASE app ENCODING 'LATIN1'", IDLE)).toEqual({
      action: 'error',
      sqlState: '0A000',
      message: 'ENCODING LATIN1 is not supported',
    });
  });

  test('rejects TEMPLATE other than template0 and TABLESPACE', () => {
    expect(recognizeDatabaseStatement('CREATE DATABASE app TEMPLATE template1', IDLE)).toEqual({
      action: 'error',
      sqlState: '0A000',
      message: 'TEMPLATE template1 is not supported',
    });
    expect(recognizeDatabaseStatement('CREATE DATABASE app TABLESPACE pg_default', IDLE)).toEqual({
      action: 'error',
      sqlState: '0A000',
      message: 'option "TABLESPACE" is not supported',
    });
  });

  test('rejects CREATE DATABASE and DROP DATABASE inside a transaction', () => {
    expect(recognizeDatabaseStatement('CREATE DATABASE app', 'T')).toEqual({
      action: 'error',
      sqlState: '25001',
      message: 'CREATE DATABASE cannot run inside a transaction block',
    });
    expect(recognizeDatabaseStatement('DROP DATABASE app', 'E')).toEqual({
      action: 'error',
      sqlState: '25001',
      message: 'DROP DATABASE cannot run inside a transaction block',
    });
  });

  test('recognizes DROP DATABASE and DROP DATABASE IF EXISTS', () => {
    expect(recognizeDatabaseStatement('drop database "App"', IDLE)).toEqual({
      action: 'drop',
      name: 'App',
      ifExists: false,
    });
    expect(recognizeDatabaseStatement('DROP DATABASE IF EXISTS missing', IDLE)).toEqual({
      action: 'drop',
      name: 'missing',
      ifExists: true,
    });
  });

  test('rejects DROP DATABASE ... FORCE', () => {
    expect(recognizeDatabaseStatement('DROP DATABASE app WITH (FORCE)', IDLE)).toEqual({
      action: 'error',
      sqlState: '0A000',
      message: 'DROP DATABASE ... FORCE is not supported',
    });
  });

  test('leaves ordinary SQL and CREATE DATABASE IF NOT EXISTS unhandled', () => {
    expect(recognizeDatabaseStatement('SELECT 1', IDLE)).toEqual({ action: 'forward' });
    expect(recognizeDatabaseStatement('CREATE DATABASE IF NOT EXISTS app', IDLE)).toEqual({
      action: 'forward',
    });
  });

  test('rejects an empty name and a name longer than 63 bytes', () => {
    expect(recognizeDatabaseStatement('CREATE DATABASE ""', IDLE)).toEqual({
      action: 'error',
      sqlState: '42602',
      message: 'invalid database name ""',
    });

    const longName = 'a'.repeat(64);

    expect(recognizeDatabaseStatement(`CREATE DATABASE ${longName}`, IDLE)).toEqual({
      action: 'error',
      sqlState: '42622',
      message: `identifier "${longName}" exceeds 63 bytes`,
    });
  });
});
