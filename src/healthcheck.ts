/**
 * Health check script for Docker health checks and monitoring
 */

async function healthCheck(): Promise<void> {
  try {
    // Perform basic health checks
    const response = await fetch('http://localhost:8765/health', {
      method: 'GET',
      headers: {
        'User-Agent': 'LocalStack-GCP-Healthcheck/1.0',
      },
    });

    if (response.ok) {
      console.log('Health check passed');
      process.exit(0);
    } else {
      console.error('Health check failed: Server returned', response.status);
      process.exit(1);
    }
  } catch (error) {
    console.error('Health check failed:', error);
    process.exit(1);
  }
}

if (import.meta.main) {
  await healthCheck();
}
