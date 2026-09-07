export type HealthDependencyStatus = 'up' | 'down';
export type HealthStatus = 'ok' | 'error';

export interface HealthResponse {
  status: HealthStatus;
  dependencies: {
    postgres: HealthDependencyStatus;
    redis: HealthDependencyStatus;
  };
}
