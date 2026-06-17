export interface ServiceConfig {
  name: string;
  port: number;
  environment: string;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  service: string;
}
