import { Request, Response, NextFunction } from 'express'
import { verifyToken, DecodedToken } from './jwt.js'
import { AUTH_COOKIE_NAME } from './constants.js'

/**
 * Check if authentication is enabled.
 * Authentication is enabled when both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
 * When not set, all routes are accessible without authentication.
 */
export function isAuthEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID) && Boolean(process.env.GOOGLE_CLIENT_SECRET)
}

/**
 * Extract JWT token from request.
 * Priority: 1. Cookie, 2. Authorization Bearer header
 */
export function extractToken(req: Request): string | null {
  // Check cookie first
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME]
  if (cookieToken) {
    return cookieToken
  }

  // Check Authorization header
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  return null
}

// Extend Express Request to include authUser (avoids conflict with passport's user)
declare global {
  namespace Express {
    interface Request {
      authUser?: DecodedToken
    }
  }
}

/**
 * Middleware: Require JWT authentication
 * - In fallback mode (GOOGLE_CLIENT_ID not set): allows all requests
 * - In auth mode: requires valid JWT token (cookie or Authorization header)
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Fallback mode: auth disabled, allow all
  if (!isAuthEnabled()) {
    return next()
  }

  const token = extractToken(req)

  if (!token) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  const decoded = verifyToken(token)

  if (!decoded) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  // Attach user to request for downstream handlers
  req.authUser = decoded
  next()
}
