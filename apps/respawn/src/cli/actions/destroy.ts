import * as p from '@clack/prompts';
import type { ActionResult, DestroyContext } from '@respawn/core';
import { destroy as coreDestroy } from '@respawn/core';

export type { DestroyContext };

/**
 * CLI front-end for the destroy action: a production teardown gets a typed
 * confirmation here, then the headless core (which never prompts) runs it.
 */
export async function destroy(ctx: DestroyContext): Promise<ActionResult> {
  if (ctx.environment === 'prod' && !ctx.force) {
    const confirmation = await p.text({
      message: `Type "${ctx.service.name}" to confirm PRODUCTION destroy:`,
      validate: (value) =>
        value !== ctx.service.name ? `You must type "${ctx.service.name}" to confirm.` : undefined,
    });
    if (p.isCancel(confirmation)) {
      return {
        success: false,
        serviceName: ctx.service.name,
        action: 'destroy',
        message: 'Cancelled by user',
        duration: 0,
      };
    }
    return coreDestroy({ ...ctx, force: true });
  }
  return coreDestroy(ctx);
}
