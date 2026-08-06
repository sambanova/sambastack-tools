import { NextRequest, NextResponse } from 'next/server';
import { inferencePodNames } from '@/app/utils/inference-pod-names';

/**
 * GET - Resolve the pod names the inference operator would create for a given
 * model deployment name.
 *
 * This is a pure computation (no cluster access needed): the operator's
 * truncate+hash naming relies on Node's `crypto`, which is server-only, so the
 * Model Deployment form calls this endpoint to preview the shortened pod names
 * instead of importing `inference-pod-names.ts` into the client bundle.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const deploymentName = searchParams.get('deploymentName');

  if (!deploymentName || typeof deploymentName !== 'string') {
    return NextResponse.json(
      { error: 'Deployment name is required' },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
    deploymentName,
    podNames: inferencePodNames(deploymentName),
  });
}
