/**
 * Control-plane /health payload.
 *
 * `status: ok` means the HTTP server is up. When Compute is enabled, also
 * report whether the Cloud Armor evaluation server bound — apply can succeed
 * while evaluation is down.
 */

export type EvaluationServerBind = '127.0.0.1' | '0.0.0.0';

export interface KingletCloudArmorEvaluationServerStatus {
  started: boolean;
  bind: EvaluationServerBind;
  port?: number;
}

export interface HealthBody {
  status: 'ok';
  kingletCloudArmorEvaluationServer?: KingletCloudArmorEvaluationServerStatus;
}

export function buildHealthBody(
  evaluationServer?: KingletCloudArmorEvaluationServerStatus
): HealthBody {
  if (evaluationServer == null) {
    return { status: 'ok' };
  }

  const kingletCloudArmorEvaluationServer: KingletCloudArmorEvaluationServerStatus = {
    started: evaluationServer.started,
    bind: evaluationServer.bind,
  };

  if (evaluationServer.port != null) {
    kingletCloudArmorEvaluationServer.port = evaluationServer.port;
  }

  return { status: 'ok', kingletCloudArmorEvaluationServer };
}
