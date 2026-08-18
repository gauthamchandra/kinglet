/**
 * Availability of a real `valkey-server` binary, for tests that exercise the
 * Memorystore data plane against the genuine thing rather than a stand-in.
 *
 * <p>Locally the binary is optional: a contributor without Valkey installed
 * still gets a green run, because those suites skip themselves.
 *
 * <p><b>IMPORTANT:</b> CI is deliberately not allowed that grace. The workflow
 * installs `valkey-server` on purpose (see `.github/workflows/ci.yml`), so if
 * it is missing there the install step has regressed — and a silent skip would
 * mean the data-plane suites stop running while CI still reports green. That is
 * the failure mode this guard exists to make impossible: in CI, a missing
 * binary is a hard error instead of a skip.
 */
const realValkeyBinaryPath = Bun.which('valkey-server');

if (realValkeyBinaryPath == null && process.env.CI) {
  throw new Error(
    'valkey-server is not on PATH but CI=true. The Memorystore data-plane tests would ' +
      'silently skip and stop catching regressions. Install it in the workflow ' +
      '(apt-get install -y valkey-server) or unset CI to run without it locally.'
  );
}

export const isRealValkeyBinaryAvailable = realValkeyBinaryPath != null;
