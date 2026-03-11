/**
 * GCP Workflows Execution Engine
 *
 * Core interpreter that parses workflow YAML and executes it step by step.
 * Supports: assign, call, switch, for, try/retry/except, return, raise, next, steps.
 */

import YAML from 'js-yaml';
import type { StdlibResolver } from './expressions.ts';
import { evaluateTemplate } from './expressions.ts';
import type { AsyncStdlibResolver, StdlibOptions } from './stdlib.ts';
import { createStdlib } from './stdlib.ts';
import type {
  EngineResult,
  VariableScope,
  WorkflowBlock,
  WorkflowDefinition,
  WorkflowStep,
} from './types.ts';
import { CALL_STACK_DEPTH_LIMIT, ErrorTag, ExecutionState, WorkflowRuntimeError } from './types.ts';

// ── Sentinel values for control flow ──

const RETURN_SENTINEL = Symbol('RETURN');
const NEXT_SENTINEL = Symbol('NEXT');
const END_SENTINEL = Symbol('END');

interface ReturnSignal {
  type: typeof RETURN_SENTINEL;
  value: unknown;
}

interface NextSignal {
  type: typeof NEXT_SENTINEL;
  target: string;
}

interface EndSignal {
  type: typeof END_SENTINEL;
}

type ControlSignal = ReturnSignal | NextSignal | EndSignal;

function isControlSignal(v: unknown): v is ControlSignal {
  if (v === null || typeof v !== 'object' || !('type' in v)) return false;

  const obj = v as { type: unknown };

  return obj.type === RETURN_SENTINEL || obj.type === NEXT_SENTINEL || obj.type === END_SENTINEL;
}

// ── Engine ──

export class WorkflowEngine {
  private definition: WorkflowDefinition;
  private stdlib: AsyncStdlibResolver;
  private syncStdlib: StdlibResolver;
  private callDepth = 0;

  constructor(yamlSource: string, options: StdlibOptions) {
    this.definition = parseWorkflowYaml(yamlSource);
    this.stdlib = createStdlib(options);
    // Synchronous wrapper for expression evaluation (never calls HTTP)
    this.syncStdlib = (name: string, args: unknown[]): unknown => {
      const result = this.stdlib(name, args);

      if (result instanceof Promise) {
        throw new WorkflowRuntimeError(
          `Async function '${name}' cannot be called inside expressions`,
          [ErrorTag.SystemError],
          0
        );
      }

      return result;
    };
  }

  async execute(args?: Record<string, unknown>): Promise<EngineResult> {
    try {
      const mainBlock = this.definition.main;
      const scope = createScope();

      // Bind main params — main accepts a single map param
      if (mainBlock.params && mainBlock.params.length > 0) {
        for (const param of mainBlock.params) {
          if (typeof param === 'string') {
            if (args && param in args) {
              scope.variables[param] = args[param];
            }
          } else {
            const paramName = firstKey(param as Record<string, unknown>);
            scope.variables[paramName] =
              args && paramName in args ? args[paramName] : param[paramName];
          }
        }
      }

      const result = await this.executeBlock(mainBlock.steps, scope);

      if (isControlSignal(result) && result.type === RETURN_SENTINEL) {
        return { output: result.value, state: ExecutionState.SUCCEEDED };
      }

      return { output: null, state: ExecutionState.SUCCEEDED };
    } catch (err) {
      if (err instanceof WorkflowRuntimeError) {
        return {
          output: null,
          state: ExecutionState.FAILED,
          error: err.toErrorObject(),
        };
      }

      return {
        output: null,
        state: ExecutionState.FAILED,
        error: {
          message: err instanceof Error ? err.message : String(err),
          tags: [ErrorTag.SystemError],
          code: 0,
        },
      };
    }
  }

  private async executeBlock(
    steps: WorkflowStep[],
    scope: VariableScope
  ): Promise<ControlSignal | undefined> {
    let i = 0;

    while (i < steps.length) {
      // bounds-checked by while condition
      const step = steps[i] as WorkflowStep;
      const result = await this.executeStep(step, scope);

      if (isControlSignal(result)) {
        if (result.type === RETURN_SENTINEL || result.type === END_SENTINEL) {
          return result;
        }

        // NEXT_SENTINEL — find target step
        if (result.type === NEXT_SENTINEL) {
          if (result.target === 'end') {
            return { type: END_SENTINEL };
          }

          const targetIndex = steps.findIndex(s => s.name === result.target);

          if (targetIndex === -1) {
            throw new WorkflowRuntimeError(
              `Step '${result.target}' not found`,
              [ErrorTag.ValueError],
              0
            );
          }

          i = targetIndex;
          continue;
        }
      }

      i++;
    }

    return undefined;
  }

  private async executeStep(
    step: WorkflowStep,
    scope: VariableScope
  ): Promise<ControlSignal | undefined> {
    const body = step.body;

    // Check for `next` field on the step body
    const nextTarget = body.next as string | undefined;

    // ── assign (standalone, not sibling of switch) ──
    if ('assign' in body && !('switch' in body)) {
      this.executeAssign(body.assign as Array<Record<string, unknown>>, scope);

      if (nextTarget) {
        return { type: NEXT_SENTINEL, target: nextTarget };
      }

      return undefined;
    }

    // ── return ──
    if ('return' in body) {
      const value = this.resolveValue(body.return, scope);

      return { type: RETURN_SENTINEL, value };
    }

    // ── raise ──
    if ('raise' in body) {
      const raised = this.resolveValue(body.raise, scope);

      if (typeof raised === 'string') {
        throw new WorkflowRuntimeError(raised, [ErrorTag.ValueError], 0);
      }

      const errObj = raised as Record<string, unknown>;

      throw new WorkflowRuntimeError(
        (errObj.message as string) ?? 'Unknown error',
        (errObj.tags as string[]) ?? [ErrorTag.ValueError],
        (errObj.code as number) ?? 0
      );
    }

    // ── call ──
    if ('call' in body) {
      const result = await this.executeCall(body, scope);

      if (body.result) {
        scope.variables[body.result as string] = result;
      }

      if (nextTarget) {
        return { type: NEXT_SENTINEL, target: nextTarget };
      }

      return undefined;
    }

    // ── switch ──
    if ('switch' in body) {
      const switchResult = await this.executeSwitch(body.switch as unknown[], scope);

      if (isControlSignal(switchResult)) {
        return switchResult;
      }

      // If switch fell through (no match) and step has a sibling assign, execute it
      if ('assign' in body) {
        this.executeAssign(body.assign as Array<Record<string, unknown>>, scope);
      }

      if (nextTarget) {
        return { type: NEXT_SENTINEL, target: nextTarget };
      }

      return undefined;
    }

    // ── for ──
    if ('for' in body) {
      const forResult = await this.executeFor(body.for as Record<string, unknown>, scope);

      if (isControlSignal(forResult)) {
        return forResult;
      }

      if (nextTarget) {
        return { type: NEXT_SENTINEL, target: nextTarget };
      }

      return undefined;
    }

    // ── try/except/retry ──
    if ('try' in body) {
      const tryResult = await this.executeTry(body, scope);

      if (isControlSignal(tryResult)) {
        return tryResult;
      }

      if (nextTarget) {
        return { type: NEXT_SENTINEL, target: nextTarget };
      }

      return undefined;
    }

    // ── steps (nested) ──
    if ('steps' in body) {
      const nestedSteps = parseSteps(body.steps as unknown[]);
      const result = await this.executeBlock(nestedSteps, scope);

      if (isControlSignal(result)) {
        return result;
      }

      if (nextTarget) {
        return { type: NEXT_SENTINEL, target: nextTarget };
      }

      return undefined;
    }

    // ── next (standalone) ──
    if ('next' in body && Object.keys(body).length === 1) {
      return { type: NEXT_SENTINEL, target: body.next as string };
    }

    return undefined;
  }

  // ── Step Executors ──

  private executeAssign(assignments: Array<Record<string, unknown>>, scope: VariableScope): void {
    for (const assignment of assignments) {
      for (const [key, value] of Object.entries(assignment)) {
        scope.variables[key] = this.resolveValue(value, scope);
      }
    }
  }

  private async executeCall(body: Record<string, unknown>, scope: VariableScope): Promise<unknown> {
    const fnName = body.call as string;
    const rawArgs = body.args as Record<string, unknown> | undefined;

    // Resolve arguments
    const resolvedArgs: Record<string, unknown> = {};

    if (rawArgs) {
      for (const [key, value] of Object.entries(rawArgs)) {
        resolvedArgs[key] = this.resolveValue(value, scope);
      }
    }

    // Check if it's a subworkflow call
    if (fnName in this.definition.subworkflows) {
      return this.callSubworkflow(fnName, resolvedArgs);
    }

    // Check for stdlib functions that take named args
    // sys.get_env takes `name`, json.encode_to_string takes `value`, etc.
    return this.callStdlib(fnName, resolvedArgs);
  }

  private async callStdlib(fnName: string, namedArgs: Record<string, unknown>): Promise<unknown> {
    // Map named args to positional args based on function signature
    const positionalArgs = mapNamedToPositional(fnName, namedArgs);

    return this.stdlib(fnName, positionalArgs);
  }

  private async callSubworkflow(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.callDepth++;

    if (this.callDepth > CALL_STACK_DEPTH_LIMIT) {
      throw new WorkflowRuntimeError(
        `Call stack depth limit exceeded (max ${CALL_STACK_DEPTH_LIMIT})`,
        [ErrorTag.RecursionError],
        0
      );
    }

    try {
      const block = this.definition.subworkflows[name] as WorkflowBlock;
      const subScope = createScope();

      // Bind params
      if (block.params) {
        for (const param of block.params) {
          if (typeof param === 'string') {
            if (param in args) {
              subScope.variables[param] = args[param];
            }
          } else {
            // Param with default: { paramName: defaultValue }
            const paramName = firstKey(param as Record<string, unknown>);
            subScope.variables[paramName] = paramName in args ? args[paramName] : param[paramName];
          }
        }
      }

      const result = await this.executeBlock(block.steps, subScope);

      if (isControlSignal(result) && result.type === RETURN_SENTINEL) {
        return result.value;
      }

      return null;
    } finally {
      this.callDepth--;
    }
  }

  private async executeSwitch(
    cases: unknown[],
    scope: VariableScope
  ): Promise<ControlSignal | undefined> {
    for (const c of cases) {
      const caseObj = c as Record<string, unknown>;
      const condition = this.resolveValue(caseObj.condition, scope);

      if (condition) {
        // Execute any assign in this case
        if ('assign' in caseObj) {
          this.executeAssign(caseObj.assign as Array<Record<string, unknown>>, scope);
        }

        // Execute any return in this case
        if ('return' in caseObj) {
          const value = this.resolveValue(caseObj.return, scope);

          return { type: RETURN_SENTINEL, value };
        }

        // Execute any raise in this case
        if ('raise' in caseObj) {
          const raised = this.resolveValue(caseObj.raise, scope);

          if (typeof raised === 'string') {
            throw new WorkflowRuntimeError(raised, [ErrorTag.ValueError], 0);
          }

          const errObj = raised as Record<string, unknown>;

          throw new WorkflowRuntimeError(
            (errObj.message as string) ?? 'Unknown error',
            (errObj.tags as string[]) ?? [ErrorTag.ValueError],
            (errObj.code as number) ?? 0
          );
        }

        // Execute any nested switch in this case
        if ('switch' in caseObj) {
          const nestedResult = await this.executeSwitch(caseObj.switch as unknown[], scope);

          if (isControlSignal(nestedResult)) return nestedResult;
        }

        // Execute any steps in this case
        if ('steps' in caseObj) {
          const steps = parseSteps(caseObj.steps as unknown[]);
          const result = await this.executeBlock(steps, scope);

          if (isControlSignal(result)) return result;
        }

        // Handle next jump
        if ('next' in caseObj) {
          return { type: NEXT_SENTINEL, target: caseObj.next as string };
        }

        return undefined; // First true wins, stop
      }
    }

    // No match — fall through
    return undefined;
  }

  private async executeFor(
    forDef: Record<string, unknown>,
    scope: VariableScope
  ): Promise<ControlSignal | undefined> {
    const valueVar = forDef.value as string;
    const indexVar = forDef.index as string | undefined;
    const collection = this.resolveValue(forDef.in, scope);
    const steps = parseSteps(forDef.steps as unknown[]);

    if (!Array.isArray(collection)) {
      throw new WorkflowRuntimeError(
        'for loop requires an iterable (list)',
        [ErrorTag.TypeError],
        0
      );
    }

    const hadValueVar = valueVar in scope.variables;
    const prevValueVar = scope.variables[valueVar];
    const hadIndexVar = indexVar ? indexVar in scope.variables : false;
    const prevIndexVar = indexVar ? scope.variables[indexVar] : undefined;

    const restoreLoopVars = () => {
      if (hadValueVar) {
        scope.variables[valueVar] = prevValueVar;
      } else {
        delete scope.variables[valueVar];
      }

      if (indexVar) {
        if (hadIndexVar) {
          scope.variables[indexVar] = prevIndexVar;
        } else {
          delete scope.variables[indexVar];
        }
      }
    };

    for (let idx = 0; idx < collection.length; idx++) {
      scope.variables[valueVar] = collection[idx];

      if (indexVar) {
        scope.variables[indexVar] = idx;
      }

      const result = await this.executeBlock(steps, scope);

      if (isControlSignal(result)) {
        restoreLoopVars();

        return result;
      }
    }

    restoreLoopVars();

    return undefined;
  }

  private async executeTry(
    body: Record<string, unknown>,
    scope: VariableScope
  ): Promise<ControlSignal | undefined> {
    const tryBlock = body.try as Record<string, unknown>;
    const retryConfig = body.retry as Record<string, unknown> | undefined;
    const exceptBlock = body.except as Record<string, unknown> | undefined;

    const maxRetries = retryConfig ? ((retryConfig.max_retries as number) ?? 0) : 0;
    const predicateName = retryConfig?.predicate as string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const steps = parseSteps(tryBlock.steps as unknown[]);
        const result = await this.executeBlock(steps, scope);

        if (isControlSignal(result)) return result;

        return undefined; // Success
      } catch (err) {
        const isLastAttempt = attempt === maxRetries;

        if (!isLastAttempt && retryConfig) {
          // If a predicate subworkflow is specified, call it to decide
          if (predicateName && predicateName in this.definition.subworkflows) {
            const errorObj =
              err instanceof WorkflowRuntimeError
                ? err.toErrorObject()
                : { message: String(err), tags: [ErrorTag.SystemError], code: 0 };

            const shouldRetry = await this.callSubworkflow(predicateName, { error: errorObj });

            if (!shouldRetry) {
              if (exceptBlock) return await this.executeExcept(exceptBlock, err, scope);

              throw err;
            }
          }

          continue;
        }

        // No more retries — check except
        if (exceptBlock) {
          return await this.executeExcept(exceptBlock, err, scope);
        }

        // No except block — re-throw
        throw err;
      }
    }

    return undefined;
  }

  private async executeExcept(
    exceptBlock: Record<string, unknown>,
    err: unknown,
    scope: VariableScope
  ): Promise<ControlSignal | undefined> {
    const asVar = exceptBlock.as as string | undefined;

    if (asVar) {
      if (err instanceof WorkflowRuntimeError) {
        scope.variables[asVar] = err.toErrorObject();
      } else {
        scope.variables[asVar] = {
          message: err instanceof Error ? err.message : String(err),
          tags: [ErrorTag.SystemError],
          code: 0,
        };
      }
    }

    const steps = parseSteps(exceptBlock.steps as unknown[]);

    return this.executeBlock(steps, scope);
  }

  // ── Value Resolution ──

  private resolveValue(value: unknown, scope: VariableScope): unknown {
    if (typeof value === 'string') {
      return evaluateTemplate(value, scope, this.syncStdlib);
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolveValue(item, scope));
    }

    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.resolveValue(v, scope);
      }

      return result;
    }

    return value;
  }
}

// ── YAML Parsing ──

function parseWorkflowYaml(yamlSource: string): WorkflowDefinition {
  const doc = YAML.load(yamlSource) as Record<string, unknown>;
  const definition: WorkflowDefinition = {
    main: { steps: [] },
    subworkflows: {},
  };

  for (const [name, block] of Object.entries(doc)) {
    const blockObj = block as Record<string, unknown>;
    const workflowBlock: WorkflowBlock = {
      steps: parseSteps(blockObj.steps as unknown[]),
    };

    if (blockObj.params) {
      workflowBlock.params = blockObj.params as string[] | Array<Record<string, unknown>>;
    }

    if (name === 'main') {
      definition.main = workflowBlock;
    } else {
      definition.subworkflows[name] = workflowBlock;
    }
  }

  return definition;
}

function parseSteps(rawSteps: unknown[]): WorkflowStep[] {
  if (!Array.isArray(rawSteps)) return [];

  return rawSteps.map(step => {
    const stepObj = step as Record<string, unknown>;
    const name = firstKey(stepObj);

    return {
      name,
      body: stepObj[name] as Record<string, unknown>,
    };
  });
}

function createScope(): VariableScope {
  return { variables: {} };
}

function firstKey(obj: Record<string, unknown>): string {
  const key = Object.keys(obj)[0];

  if (key === undefined) {
    throw new WorkflowRuntimeError('Empty parameter definition', [ErrorTag.ValueError], 0);
  }

  return key;
}

// ── Named to Positional Arg Mapping ──

const ARG_MAPPINGS: Record<string, string[]> = {
  'sys.get_env': ['name'],
  'sys.log': ['severity', 'text'],
  'sys.sleep': ['seconds'],
  'json.encode_to_string': ['value'],
  'json.encode': ['value'],
  'json.decode': ['value'],
  'base64.encode': ['data'],
  'base64.decode': ['data'],
  'text.to_lower': ['s'],
  'text.to_upper': ['s'],
  'text.find_all': ['source', 'value'],
  'text.replace_all': ['source', 'value', 'replacement'],
  'text.split': ['source', 'delimiter'],
  'text.substring': ['source', 'start', 'end'],
  'text.url_encode': ['value'],
  'map.get': ['map', 'key', 'default'],
  'map.merge': ['first', 'second'],
  'map.merge_nested': ['first', 'second'],
  'map.keys': ['map'],
  'map.values': ['map'],
  'list.concat': ['list', 'value'],
  'list.prepend': ['list', 'value'],
  'list.range': ['start', 'end'],
  'math.abs': ['value'],
  'math.max': ['first', 'second'],
  'math.min': ['first', 'second'],
  'http.get': ['url', 'headers', 'auth', 'timeout', 'body', 'query'],
  'http.post': ['url', 'headers', 'auth', 'timeout', 'body', 'query'],
  'http.request': ['url', 'method', 'headers', 'auth', 'timeout', 'body', 'query'],
};

function mapNamedToPositional(fnName: string, namedArgs: Record<string, unknown>): unknown[] {
  // For http methods, pass the entire args map as a single argument
  if (fnName.startsWith('http.') && fnName !== 'http.default_retry_predicate') {
    return [namedArgs];
  }

  const mapping = ARG_MAPPINGS[fnName];

  if (!mapping) {
    // No mapping known — pass all values as positional
    return Object.values(namedArgs);
  }

  const positional = mapping.map(name => namedArgs[name]);

  // Only trim trailing undefined values — preserve middle ones to keep positions correct
  let lastDefined = positional.length - 1;

  while (lastDefined >= 0 && positional[lastDefined] === undefined) {
    lastDefined--;
  }

  return positional.slice(0, lastDefined + 1);
}
