/**
 * Google OAuth 인증 설정.
 *
 * 허용 이메일 주소가 환경변수 ORCH_ALLOWED_EMAIL과 일치하는 경우에만 인증을 승인한다.
 */

import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import type { Express, Request, Response, NextFunction } from "express";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  allowedEmail: string;
  sessionSecret: string;
}

/** passport + Google OAuth 전략을 Express 앱에 등록한다. */
export function configurePassport(config: AuthConfig): void {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.clientId,
        clientSecret: config.clientSecret,
        callbackURL: config.callbackUrl,
      },
      (_accessToken, _refreshToken, profile, done) => {
        const email = profile.emails?.[0]?.value ?? "";
        if (email.toLowerCase() === config.allowedEmail.toLowerCase()) {
          return done(null, { id: profile.id, email, displayName: profile.displayName });
        }
        return done(null, false, { message: "Email not allowed" });
      },
    ),
  );

  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user: unknown, done) => {
    done(null, user as Express.User);
  });
}

/** 인증 여부 미들웨어. 미인증 요청은 /login으로 리다이렉트. */
export function ensureAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.isAuthenticated()) {
    next();
    return;
  }
  // API 요청은 401 반환
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.redirect("/login");
}
