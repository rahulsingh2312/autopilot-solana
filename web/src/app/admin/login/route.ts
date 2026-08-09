import { NextResponse } from "next/server";

import {
  ADMIN_SESSION_COOKIE,
  checkPassword,
  createSession,
} from "@/lib/admin/session";

export const dynamic = "force-dynamic";

/**
 * Login and logout for the admin panel.
 *
 * Posting the form sets a signed session cookie; posting with `logout` clears
 * it. There is no rate limiting here because the panel is not linked from
 * anywhere and the password is the only guess surface — if that changes, this
 * is the first place that needs it.
 */
export async function POST(request: Request) {
  const form = await request.formData();

  if (form.get("logout")) {
    const response = NextResponse.redirect(new URL("/admin", request.url), 303);
    response.cookies.delete(ADMIN_SESSION_COOKIE);
    return response;
  }

  const password = String(form.get("password") ?? "");
  if (!checkPassword(password)) {
    return NextResponse.redirect(new URL("/admin?error=1", request.url), 303);
  }

  const session = createSession();
  if (!session) {
    return NextResponse.redirect(new URL("/admin?error=config", request.url), 303);
  }

  const response = NextResponse.redirect(new URL("/admin", request.url), 303);
  response.cookies.set(ADMIN_SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}
