/**
 * Terraform validation harness primitives.
 *
 * Used by terraform.test.ts (TDD entry point) and scripts/terraform-e2e.sh.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TerraformValidationCase } from './manifest.ts';

const ROOT_DIR = resolve(import.meta.dir, '..');
const TF_DIR = resolve(ROOT_DIR, 'terraform');
const CONTAINER_NAME = 'kinglet-terraform-validation';
const IMAGE_NAME = 'kinglet:terraform-validation';

export type KingletMode = 'bun' | 'docker';

export interface HarnessOptions {
  kingletMode?: KingletMode;
  skipDockerBuild?: boolean;
  port?: number;
}

interface RunningKinglet {
  stop: () => Promise<void>;
  endpoint: string;
}

type ResourceStopper = () => Promise<void>;

async function removeValidationContainer(): Promise<void> {
  await Bun.spawn(['docker', 'rm', '-f', CONTAINER_NAME], { stdout: 'ignore', stderr: 'ignore' })
    .exited;
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('ok'),
  });
  const port = server.port;

  server.stop(true);

  return port;
}

async function waitForHealth(endpoint: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // kinglet still starting
    }

    await Bun.sleep(500);
  }

  throw new Error(`Timed out waiting for kinglet health at ${endpoint}/health`);
}

async function startKingletBun(
  services: readonly string[],
  port: number,
  onResourceStarted?: (stop: ResourceStopper) => void
): Promise<RunningKinglet> {
  const endpoint = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn({
    cmd: ['bun', 'run', 'src/index.ts'],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      STORAGE_TYPE: 'memory',
      AUTH_MODE: 'bypass',
      MOCK_PROJECT_ID: 'kinglet-terraform-validation',
      SERVICES: services.join(','),
      MEMORYSTORE_DATA_PLANE: 'false',
      HTTP_PORT: String(port),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const stopProc = async (): Promise<void> => {
    proc.kill();
    await proc.exited;
  };

  onResourceStarted?.(stopProc);

  try {
    await waitForHealth(endpoint);
  } catch (err) {
    await stopProc();
    throw err;
  }

  return {
    endpoint,
    stop: stopProc,
  };
}

async function startKingletDocker(
  services: readonly string[],
  port: number,
  skipDockerBuild: boolean,
  onResourceStarted?: (stop: ResourceStopper) => void
): Promise<RunningKinglet> {
  const endpoint = `http://127.0.0.1:${port}`;

  await removeValidationContainer();

  if (!skipDockerBuild) {
    const build = Bun.spawn(['docker', 'build', '-t', IMAGE_NAME, ROOT_DIR], {
      stdout: 'inherit',
      stderr: 'inherit',
    });

    onResourceStarted?.(async () => {
      build.kill();
      await build.exited;
      await removeValidationContainer();
    });

    const buildExit = await build.exited;

    if (buildExit !== 0) {
      throw new Error(`docker build failed with exit ${buildExit}`);
    }
  }

  const run = Bun.spawn(
    [
      'docker',
      'run',
      '-d',
      '--name',
      CONTAINER_NAME,
      '-p',
      `${port}:8765`,
      '-e',
      'STORAGE_TYPE=memory',
      '-e',
      'AUTH_MODE=bypass',
      '-e',
      `MOCK_PROJECT_ID=kinglet-terraform-validation`,
      '-e',
      `SERVICES=${services.join(',')}`,
      '-e',
      'MEMORYSTORE_DATA_PLANE=false',
      IMAGE_NAME,
    ],
    { stdout: 'ignore', stderr: 'inherit' }
  );

  onResourceStarted?.(async () => {
    run.kill();
    await run.exited;
    await removeValidationContainer();
  });

  const runExit = await run.exited;

  if (runExit !== 0) {
    await removeValidationContainer();
    throw new Error(`docker run failed with exit ${runExit}`);
  }

  onResourceStarted?.(removeValidationContainer);

  try {
    await waitForHealth(endpoint);
  } catch (err) {
    await removeValidationContainer();
    throw err;
  }

  return {
    endpoint,
    stop: removeValidationContainer,
  };
}

async function startKinglet(
  services: readonly string[],
  options: HarnessOptions,
  onResourceStarted?: (stop: ResourceStopper) => void
): Promise<RunningKinglet> {
  const mode =
    options.kingletMode ?? (process.env.KINGLET_MODE as KingletMode | undefined) ?? 'bun';
  const port =
    options.port ??
    (process.env.KINGLET_PORT != null ? Number(process.env.KINGLET_PORT) : undefined) ??
    (await getFreePort());

  if (mode === 'docker') {
    return startKingletDocker(
      services,
      port,
      options.skipDockerBuild ?? process.env.SKIP_DOCKER_BUILD === '1',
      onResourceStarted
    );
  }

  return startKingletBun(services, port, onResourceStarted);
}

async function runTerraformCommand(
  args: string[],
  env: Record<string, string>
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['terraform', ...args], {
    cwd: TF_DIR,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    exitCode,
    output: `${stdout}${stderr}`,
  };
}

function targetArgs(targets: readonly string[]): string[] {
  return targets.flatMap(target => ['-target', target]);
}

export async function initTerraform(stateDir: string): Promise<void> {
  const result = await runTerraformCommand(['init', '-input=false', '-no-color'], {
    TF_DATA_DIR: join(stateDir, '.terraform'),
  });

  if (result.exitCode !== 0) {
    throw new Error(`terraform init failed:\n${result.output}`);
  }
}

export interface ValidationCaseResult {
  id: string;
}

export async function runValidationCase(
  validationCase: TerraformValidationCase,
  options: HarnessOptions = {}
): Promise<ValidationCaseResult> {
  const stateDir = await mkdtemp(join(tmpdir(), 'kinglet-terraform-'));
  const stateFile = join(stateDir, 'terraform.tfstate');
  const tfEnv = {
    TF_DATA_DIR: join(stateDir, '.terraform'),
  };
  let kinglet: RunningKinglet | undefined;
  let pendingResourceStop: ResourceStopper | undefined;
  let cleanedUp = false;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    if (kinglet) {
      await kinglet.stop();
      kinglet = undefined;
    } else if (pendingResourceStop) {
      await pendingResourceStop();
      pendingResourceStop = undefined;
    }

    await rm(stateDir, { recursive: true, force: true });
  };

  const onSignal = (signal: string): void => {
    void cleanup().finally(() => {
      const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;

      process.exit(exitCode);
    });
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    kinglet = await startKinglet(validationCase.services, options, stop => {
      pendingResourceStop = stop;
    });
    pendingResourceStop = undefined;

    await initTerraform(stateDir);

    const applyArgs = [
      'apply',
      '-input=false',
      '-auto-approve',
      '-no-color',
      `-state=${stateFile}`,
      `-var=kinglet_endpoint=${kinglet.endpoint}`,
      ...targetArgs(validationCase.targets),
    ];
    const apply = await runTerraformCommand(applyArgs, tfEnv);

    if (apply.exitCode !== 0) {
      throw new Error(`[${validationCase.id}] terraform apply failed:\n${apply.output}`);
    }

    const planArgs = [
      'plan',
      '-input=false',
      '-detailed-exitcode',
      '-no-color',
      `-state=${stateFile}`,
      `-var=kinglet_endpoint=${kinglet.endpoint}`,
      ...targetArgs(validationCase.targets),
    ];
    const plan = await runTerraformCommand(planArgs, tfEnv);

    if (plan.exitCode !== 0) {
      throw new Error(
        `[${validationCase.id}] post-apply plan detected drift (exit ${plan.exitCode}):\n${plan.output}`
      );
    }

    const destroyArgs = [
      'destroy',
      '-input=false',
      '-auto-approve',
      '-no-color',
      `-state=${stateFile}`,
      `-var=kinglet_endpoint=${kinglet.endpoint}`,
      ...targetArgs(validationCase.targets),
    ];
    const destroy = await runTerraformCommand(destroyArgs, tfEnv);

    if (destroy.exitCode !== 0) {
      throw new Error(`[${validationCase.id}] terraform destroy failed:\n${destroy.output}`);
    }

    const list = await runTerraformCommand(['state', 'list', `-state=${stateFile}`], tfEnv);

    if (list.exitCode !== 0) {
      throw new Error(`[${validationCase.id}] terraform state list failed:\n${list.output}`);
    }

    if (list.output.trim().length > 0) {
      throw new Error(
        `[${validationCase.id}] terraform state not empty after destroy:\n${list.output}`
      );
    }

    return { id: validationCase.id };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}
