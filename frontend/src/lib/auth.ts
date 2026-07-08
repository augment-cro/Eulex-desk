import { NextRequest } from 'next/server';

/**
 * Extract and validate user from OAuth JWT token.
 * Performs a lightweight decode (claims are verified by the backend).
 *
 * @param request NextRequest with Authorization header
 * @returns User object with email and id, or null
 */
export async function getUserFromRequest(request: NextRequest): Promise<{
  email: string;
  id: string;
} | null> {
  try {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.substring(7);

    if (!token) {
      return null;
    }

    // Decode JWT payload (signature verified by backend)
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8')
    );

    if (!payload.email || !payload.sub) {
      console.warn('[Auth] JWT missing email or sub');
      return null;
    }

    // Check expiry
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      console.warn('[Auth] JWT expired');
      return null;
    }

    console.log(`[Auth] User authenticated: ${payload.email}`);
    return {
      email: payload.email,
      id: String(payload.sub),
    };
  } catch (error) {
    console.error('[Auth] Error validating token:', error);
    return null;
  }
}
