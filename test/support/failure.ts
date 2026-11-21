import type { HttpException } from '@nestjs/common';

// Runs a promise that should reject with an HttpException and returns its status and error code.
export async function failure(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), code: (e.getResponse() as { code?: string }).code };
  }
  throw new Error('Expected the promise to reject');
}