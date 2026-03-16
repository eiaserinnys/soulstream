import passport from 'passport'
import { Strategy as GoogleStrategy, Profile, VerifyCallback } from 'passport-google-oauth20'

export interface GoogleUser {
  id: string
  email: string
  name: string
  picture?: string
}

/**
 * Configure Passport with Google OAuth strategy
 * This should be called once during app initialization.
 *
 * If GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing, emits a warning
 * and skips Strategy registration (safe degradation — auth remains disabled).
 */
export function configurePassport(): void {
  const clientID = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const callbackURL = process.env.GOOGLE_CALLBACK_URL ?? '/api/auth/google/callback'
  const allowedEmail = process.env.ALLOWED_EMAIL

  if (!clientID || !clientSecret) {
    console.warn(
      '⚠️ [dashboard] Google OAuth not configured: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing — OAuth endpoints will be disabled'
    )
    return
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
        scope: ['profile', 'email'],
      },
      (
        _accessToken: string,
        _refreshToken: string,
        profile: Profile,
        done: VerifyCallback
      ) => {
        const email = profile.emails?.[0]?.value
        const name = profile.displayName

        if (!email) {
          return done(new Error('No email found in Google profile'), undefined)
        }

        // Check if email is allowed (single-user mode)
        if (allowedEmail && email !== allowedEmail) {
          console.warn(`[dashboard] Unauthorized login attempt from email: ${email}`)
          return done(new Error('This email is not authorized to access this application'), undefined)
        }

        const user: GoogleUser = {
          id: profile.id,
          email,
          name: name || email.split('@')[0],
          picture: profile.photos?.[0]?.value,
        }

        return done(null, user)
      }
    )
  )

  // Note: serialize/deserialize not actively used with JWT-based auth (session: false)
  passport.serializeUser((user, done) => {
    done(null, user)
  })

  passport.deserializeUser((user: GoogleUser, done) => {
    done(null, user)
  })
}

export { passport }
