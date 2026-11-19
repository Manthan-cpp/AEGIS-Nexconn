import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

// Authentication is available globally, but no page is protected yet.
// This preserves the guest path while preparing DMs and community routes.
const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

const authMiddleware = clerkConfigured ? clerkMiddleware() : null;

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!authMiddleware) return NextResponse.next();

  const response = (await authMiddleware(request, event)) ?? NextResponse.next();

  // Clerk v7 turns NextResponse.next() into a same-URL rewrite to attach auth
  // headers. Next 16's Node proxy forwards that rewrite to itself, causing a
  // socket reset. Restore the normal next signal and keep Clerk's auth headers.
  if (response.headers.get("x-middleware-rewrite") === request.url) {
    response.headers.delete("x-middleware-rewrite");
    response.headers.set("x-middleware-next", "1");
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|png|jpg|jpeg|gif|svg|ttf|woff2?|ico|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
