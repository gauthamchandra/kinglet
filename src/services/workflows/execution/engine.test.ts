/**
 * Execution engine tests — written BEFORE implementation (TDD)
 *
 * Tests the core workflow interpreter:
 * - YAML parsing → workflow definition
 * - assign steps
 * - call steps (stdlib + subworkflows)
 * - switch steps (first-true-wins, fall-through)
 * - for loops (with loop-local scoping)
 * - try/retry/except
 * - return and raise
 * - next step jumps and next: end
 * - variable scoping (subworkflow isolation)
 * - call stack depth limit
 */

import { describe, expect, test } from 'bun:test';
import { WorkflowEngine } from './engine.ts';

const defaultEnv: Record<string, string> = {
  GOOGLE_CLOUD_PROJECT_ID: 'test-project',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
  GOOGLE_CLOUD_WORKFLOW_ID: 'test-workflow',
  GOOGLE_CLOUD_WORKFLOW_REVISION_ID: '000001-abc',
  GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID: 'exec-1',
  GOOGLE_CLOUD_PROJECT_NUMBER: '123456789',
};

async function run(yaml: string, args?: Record<string, unknown>) {
  const engine = new WorkflowEngine(yaml, { envVars: defaultEnv });

  return engine.execute(args);
}

describe('Workflow Engine', () => {
  // ── Assign Steps ──

  describe('assign steps', () => {
    test('assigns literal values', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - x: 10
          - name: "hello"
    - done:
        return: \${x}
`);
      expect(result.output).toBe(10);
      expect(result.state).toBe('SUCCEEDED');
    });

    test('later assignments can reference earlier ones', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - x: 5
          - y: \${x + 3}
    - done:
        return: \${y}
`);
      expect(result.output).toBe(8);
    });

    test('assigns nested maps and lists', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - data:
              name: "test"
              items:
                - 1
                - 2
                - 3
    - done:
        return: \${data.name}
`);
      expect(result.output).toBe('test');
    });
  });

  // ── Return ──

  describe('return steps', () => {
    test('returns a literal value', async () => {
      const result = await run(`
main:
  steps:
    - done:
        return: 42
`);
      expect(result.output).toBe(42);
    });

    test('returns an expression result', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - x: 10
    - done:
        return: \${x * 2}
`);
      expect(result.output).toBe(20);
    });

    test('returns a map', async () => {
      const result = await run(`
main:
  steps:
    - done:
        return:
          status: "ok"
          code: 200
`);
      expect(result.output).toEqual({ status: 'ok', code: 200 });
    });

    test('implicit return (no return statement) returns null', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - x: 1
`);
      expect(result.output).toBeNull();
    });
  });

  // ── Raise ──

  describe('raise steps', () => {
    test('raise with string message', async () => {
      const result = await run(`
main:
  steps:
    - fail:
        raise: "something went wrong"
`);
      expect(result.state).toBe('FAILED');
      expect(result.error).toBeDefined();
      expect(result.error?.message).toBe('something went wrong');
    });

    test('raise with map (code + message)', async () => {
      const result = await run(`
main:
  steps:
    - fail:
        raise:
          code: 404
          message: "Not found"
`);
      expect(result.state).toBe('FAILED');
      expect(result.error?.message).toBe('Not found');
      expect(result.error?.code).toBe(404);
    });
  });

  // ── Next Step Jumps ──

  describe('next steps', () => {
    test('next jumps to a named step', async () => {
      const result = await run(`
main:
  steps:
    - first:
        assign:
          - x: 1
        next: third
    - second:
        assign:
          - x: 999
    - third:
        return: \${x}
`);
      expect(result.output).toBe(1);
    });

    test('next: end terminates with null', async () => {
      const result = await run(`
main:
  steps:
    - first:
        assign:
          - x: 42
        next: end
    - second:
        return: 999
`);
      expect(result.output).toBeNull();
    });
  });

  // ── Call Steps (stdlib) ──

  describe('call steps (stdlib)', () => {
    test('calls sys.get_env with result', async () => {
      const result = await run(`
main:
  steps:
    - getProject:
        call: sys.get_env
        args:
          name: "GOOGLE_CLOUD_PROJECT_ID"
        result: projectId
    - done:
        return: \${projectId}
`);
      expect(result.output).toBe('test-project');
    });

    test('calls json.encode_to_string', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - data:
              key: "value"
    - encode:
        call: json.encode_to_string
        args:
          value: \${data}
        result: encoded
    - done:
        return: \${encoded}
`);
      expect(result.output).toBe('{"key":"value"}');
    });
  });

  // ── Switch Steps ──

  describe('switch steps', () => {
    test('first-true-wins', async () => {
      const result = await run(
        `
main:
  params: [input]
  steps:
    - check:
        switch:
          - condition: \${input.type == "A"}
            assign:
              - result: "matched A"
          - condition: \${input.type == "B"}
            assign:
              - result: "matched B"
    - done:
        return: \${result}
`,
        { input: { type: 'A' } }
      );
      expect(result.output).toBe('matched A');
    });

    test('fall-through when no condition matches', async () => {
      const result = await run(
        `
main:
  params: [input]
  steps:
    - check:
        switch:
          - condition: \${input.type == "A"}
            assign:
              - result: "A"
          - condition: \${input.type == "B"}
            assign:
              - result: "B"
    - fallback:
        assign:
          - result: "none matched"
    - done:
        return: \${result}
`,
        { input: { type: 'C' } }
      );
      expect(result.output).toBe('none matched');
    });

    test('switch with next jump', async () => {
      const result = await run(
        `
main:
  params: [input]
  steps:
    - check:
        switch:
          - condition: \${input.value > 10}
            next: big
    - small:
        return: "small"
    - big:
        return: "big"
`,
        { input: { value: 20 } }
      );
      expect(result.output).toBe('big');
    });
  });

  // ── For Loops ──

  describe('for loops', () => {
    test('iterates over a list', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - total: 0
    - loop:
        for:
          value: item
          in:
            - 1
            - 2
            - 3
          steps:
            - add:
                assign:
                  - total: \${total + item}
    - done:
        return: \${total}
`);
      expect(result.output).toBe(6);
    });

    test('loop variable is local to loop', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - items:
              - "a"
              - "b"
    - loop:
        for:
          value: item
          in: \${items}
          steps:
            - noop:
                assign:
                  - lastSeen: \${item}
    - done:
        return: \${lastSeen}
`);
      // lastSeen was declared in the outer scope implicitly by assign
      expect(result.output).toBe('b');
    });

    test('accumulator declared before loop works', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - collected: []
    - loop:
        for:
          value: x
          in:
            - "a"
            - "b"
          steps:
            - accumulate:
                assign:
                  - collected: \${list.concat(collected, x)}
    - done:
        return: \${collected}
`);
      expect(result.output).toEqual(['a', 'b']);
    });
  });

  // ── Subworkflows ──

  describe('subworkflows', () => {
    test('calls a subworkflow and gets return value', async () => {
      const result = await run(`
main:
  steps:
    - callSub:
        call: addNumbers
        args:
          a: 10
          b: 20
        result: sum
    - done:
        return: \${sum}

addNumbers:
  params: [a, b]
  steps:
    - compute:
        return: \${a + b}
`);
      expect(result.output).toBe(30);
    });

    test('subworkflow has isolated scope', async () => {
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - x: 100
    - callSub:
        call: readX
        result: subResult
    - done:
        return:
          mainX: \${x}
          subResult: \${subResult}

readX:
  steps:
    - tryRead:
        assign:
          - x: 999
    - done:
        return: \${x}
`);
      const output = result.output as Record<string, unknown>;
      expect(output.mainX).toBe(100); // main scope unchanged
      expect(output.subResult).toBe(999); // subworkflow had its own x
    });

    test('subworkflow without return yields null', async () => {
      const result = await run(`
main:
  steps:
    - callSub:
        call: doNothing
        result: val
    - done:
        return: \${val}

doNothing:
  steps:
    - noop:
        assign:
          - x: 1
`);
      expect(result.output).toBeNull();
    });
  });

  // ── Try / Except ──

  describe('try/except', () => {
    test('except catches raised errors', async () => {
      const result = await run(`
main:
  steps:
    - attempt:
        try:
          steps:
            - fail:
                raise: "boom"
        except:
          as: e
          steps:
            - handle:
                return: \${e.message}
`);
      expect(result.output).toBe('boom');
    });

    test('except catches runtime errors', async () => {
      const result = await run(`
main:
  steps:
    - attempt:
        try:
          steps:
            - bad:
                assign:
                  - x: \${1 / 0}
        except:
          as: e
          steps:
            - handle:
                return: "caught"
`);
      expect(result.output).toBe('caught');
    });

    test('try without error proceeds normally', async () => {
      const result = await run(`
main:
  steps:
    - attempt:
        try:
          steps:
            - ok:
                assign:
                  - x: 42
        except:
          as: e
          steps:
            - handle:
                return: "error"
    - done:
        return: \${x}
`);
      expect(result.output).toBe(42);
    });
  });

  // ── Try / Retry ──

  describe('try/retry', () => {
    test('retry re-executes steps on failure', async () => {
      // Use a counter via assign to simulate transient failure
      const result = await run(`
main:
  steps:
    - init:
        assign:
          - attempt: 0
    - attempt:
        try:
          steps:
            - increment:
                assign:
                  - attempt: \${attempt + 1}
            - mayFail:
                switch:
                  - condition: \${attempt < 3}
                    raise: "transient error"
        retry:
          max_retries: 5
          backoff:
            initial_delay: 0
            max_delay: 0
            multiplier: 1
    - done:
        return: \${attempt}
`);
      expect(result.output).toBe(3);
    });
  });

  // ── Params (main workflow) ──

  describe('main params', () => {
    test('main receives a single map param', async () => {
      const result = await run(
        `
main:
  params: [args]
  steps:
    - done:
        return: \${args.name}
`,
        { args: { name: 'test' } }
      );
      expect(result.output).toBe('test');
    });

    test('main with no params and no args succeeds', async () => {
      const result = await run(`
main:
  steps:
    - done:
        return: "ok"
`);
      expect(result.output).toBe('ok');
    });
  });

  // ── Call Stack Depth ──

  describe('call stack depth', () => {
    test('raises RecursionError on deep recursion', async () => {
      const result = await run(`
main:
  steps:
    - start:
        call: recurse
        args:
          n: 0
        result: val
    - done:
        return: \${val}

recurse:
  params: [n]
  steps:
    - go:
        call: recurse
        args:
          n: \${n + 1}
        result: val
    - done:
        return: \${val}
`);
      expect(result.state).toBe('FAILED');
      expect(result.error?.tags).toContain('RecursionError');
    });
  });

  // ── Nested Steps ──

  describe('nested steps', () => {
    test('executes nested steps block', async () => {
      const result = await run(`
main:
  steps:
    - outer:
        steps:
          - inner1:
              assign:
                - x: 10
          - inner2:
              assign:
                - y: 20
    - done:
        return: \${x + y}
`);
      expect(result.output).toBe(30);
    });
  });

  // ── Complex workflow ──

  describe('complex workflow', () => {
    test('combines assign, switch, for, call, return', async () => {
      const result = await run(
        `
main:
  params: [input]
  steps:
    - init:
        assign:
          - items: \${input.items}
          - total: 0
    - calculate:
        for:
          value: item
          in: \${items}
          steps:
            - add:
                assign:
                  - total: \${total + item}
    - classify:
        switch:
          - condition: \${total > 100}
            return: "high"
          - condition: \${total > 50}
            return: "medium"
    - lowResult:
        return: "low"
`,
        { input: { items: [10, 20, 30] } }
      );
      // 10+20+30 = 60, which is > 50 → "medium"
      expect(result.output).toBe('medium');
    });
  });
});
