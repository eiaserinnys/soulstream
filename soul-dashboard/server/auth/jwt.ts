import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken'

export interface TokenPayload {
  email: string
  name: string
}

export interface DecodedToken extends TokenPayload {
  iat?: number
  exp?: number
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set')
  }
  return secret
}

/**
 * Generate a JWT token for the given user
 * @param payload - User information to encode
 * @param expiresIn - Token expiration time (default: 7 days)
 * @returns JWT token string
 */
export function generateToken(
  payload: TokenPayload,
  expiresIn?: SignOptions['expiresIn']
): string {
  const secret = getSecret()

  const options: SignOptions = {
    expiresIn: expiresIn ?? '7d',
  }

  return jwt.sign(payload, secret, options)
}

/**
 * Verify and decode a JWT token
 * @param token - JWT token to verify
 * @returns Decoded payload or null if invalid
 */
export function verifyToken(token: string): DecodedToken | null {
  if (!token) {
    return null
  }

  try {
    const secret = getSecret()
    const decoded = jwt.verify(token, secret) as JwtPayload

    if (typeof decoded === 'object' && decoded.email && decoded.name) {
      return {
        email: decoded.email as string,
        name: decoded.name as string,
        iat: decoded.iat,
        exp: decoded.exp,
      }
    }

    return null
  } catch {
    return null
  }
}
