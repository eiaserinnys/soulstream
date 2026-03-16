import { Router, Request, Response, NextFunction } from 'express'
import passport from 'passport'
import express from 'express'
import { generateToken, verifyToken } from './jwt.js'
import { GoogleUser } from './passport.js'

/**
 * Check if authentication is enabled (GOOGLE_CLIENT_ID set).
 * Mirrors isAuthEnabled() in middleware.ts — routes.ts defines it locally
 * to avoid a circular dependency (middleware.ts imports AUTH_COOKIE_NAME from here).
 */
function isAuthEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID)
}

export const AUTH_COOKIE_NAME = 'soul_dashboard_auth'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds

/**
 * Extract token from request (cookie or Authorization header)
 */
function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME]
  if (cookieToken) {
    return cookieToken
  }

  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  return null
}

/**
 * Get current user from request
 */
function getCurrentUser(req: Request) {
  const token = extractToken(req)
  if (!token) return null
  return verifyToken(token)
}

/**
 * Set auth cookie with JWT token
 */
function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  })
}

/**
 * Clear auth cookie
 */
function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  })
}

/**
 * Create the auth router
 * Mount at /api/auth
 */
export function createAuthRouter(): Router {
  const router = Router()

  // Parse JSON body for dev-login
  router.use(express.json())

  // GET /api/auth/config — Authentication configuration (public endpoint)
  router.get('/config', (_req: Request, res: Response) => {
    const devModeEnabled = process.env.NODE_ENV !== 'production'
    const allowedEmail = process.env.ALLOWED_EMAIL

    const payload: {
      authEnabled: boolean
      devModeEnabled: boolean
      allowedEmail?: string
    } = {
      authEnabled: isAuthEnabled(),
      devModeEnabled,
    }

    if (allowedEmail) {
      payload.allowedEmail = allowedEmail
    }

    res.json(payload)
  })

  // GET /api/auth/google — Initiate Google OAuth
  router.get('/google', (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthEnabled()) {
      return res.status(503).json({ error: 'Google OAuth not configured' })
    }

    passport.authenticate('google', {
      scope: ['profile', 'email'],
    })(req, res, next)
  })

  // GET /api/auth/google/callback — Google OAuth callback
  router.get(
    '/google/callback',
    (req: Request, res: Response, _next: NextFunction) => {
      if (!isAuthEnabled()) {
        return res.status(503).json({ error: 'Google OAuth not configured' })
      }

      passport.authenticate('google', {
        session: false,
        failureRedirect: '/?error=auth_failed',
      })(req, res, (err: Error | null) => {
        if (err) {
          console.error('[dashboard] Google OAuth error:', err.message)
          return res.redirect('/?error=auth_failed')
        }

        const user = req.user as GoogleUser | undefined
        if (!user) {
          return res.redirect('/?error=no_user')
        }

        // Generate JWT and set cookie
        const token = generateToken({
          email: user.email,
          name: user.name,
        })

        setAuthCookie(res, token)

        // Redirect to home page
        res.redirect('/')
      })
    }
  )

  // GET /api/auth/status — Check authentication status
  router.get('/status', (req: Request, res: Response) => {
    const user = getCurrentUser(req)

    if (user) {
      res.json({
        authenticated: true,
        user: {
          email: user.email,
          name: user.name,
        },
      })
    } else {
      res.json({ authenticated: false })
    }
  })

  // POST /api/auth/logout — Clear auth cookie
  router.post('/logout', (_req: Request, res: Response) => {
    clearAuthCookie(res)
    res.json({ success: true })
  })

  // POST /api/auth/dev-login — Development-only login
  // Enabled when devModeEnabled (NODE_ENV !== 'production')
  router.post('/dev-login', (req: Request, res: Response) => {
    const devModeEnabled = process.env.NODE_ENV !== 'production'

    if (!devModeEnabled) {
      return res.status(403).json({
        error: 'Dev login is only available in non-production environments',
      })
    }

    const { email, name } = req.body

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Invalid email format' })
    }

    if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
      return res.status(400).json({ error: 'Invalid name' })
    }

    const userName = name || email.split('@')[0]

    const token = generateToken({ email, name: userName })

    setAuthCookie(res, token)

    res.json({
      success: true,
      user: { email, name: userName },
    })
  })

  return router
}

export default createAuthRouter
