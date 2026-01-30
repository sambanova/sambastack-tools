/**
 * Next.js Instrumentation
 * This file runs once when the Next.js server starts up.
 * Used to initialize server-side resources and run startup tasks.
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server side
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[Instrumentation] Server starting up...');

    // Generate PEF configs for the current environment on startup
    // This ensures configs are available if user doesn't switch environments
    const { generatePefConfigs } = await import('./app/utils/pef-config-generator');

    console.log('[Instrumentation] Generating PEF configs for current environment...');
    const result = await generatePefConfigs();

    if (result.success) {
      console.log(`[Instrumentation] PEF configs generated successfully (${result.count} configs)`);
    } else {
      console.log(`[Instrumentation] PEF config generation skipped or failed: ${result.error || 'Unknown error'}`);
    }

    console.log('[Instrumentation] Server startup complete');
  }
}
