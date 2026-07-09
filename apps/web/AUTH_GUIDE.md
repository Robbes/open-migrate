# Authentication Guide

## Overview

The application uses NextAuth.js v5 (beta) for authentication with a credentials provider. This guide covers the setup, usage, and customization of the authentication system.

## Demo Credentials

For development purposes, the following demo credentials are available:

- **Email:** `demo@example.com`
- **Password:** `demo123`

⚠️ **Important:** These are demo credentials only. In production, you must implement proper authentication against your user database.

## Configuration

### Environment Variables

```env
# Required
NEXTAUTH_SECRET=<secure-random-string>
NEXTAUTH_URL=http://localhost:3000

# Optional (for production)
# DATABASE_URL=...
```

Generate a secure secret:
```bash
openssl rand -base64 32
```

### Auth Configuration

Location: `src/lib/auth.ts`

```typescript
const authOptions = {
  providers: [
    CredentialsProvider({
      // Configuration
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user }) { ... },
    async session({ session, token }) { ... },
  },
};
```

## Usage

### Client-Side Session Access

```tsx
import { useSession } from "next-auth/react";

export function UserProfile() {
  const { data: session, status } = useSession();

  if (status === "loading") return <div>Loading...</div>;
  if (status === "unauthenticated") return <div>Not logged in</div>;

  return <div>Welcome, {session.user.email}</div>;
}
```

### Server-Side Session Access

```tsx
import { auth } from "@/lib/auth";

export default async function Page() {
  const session = await auth();
  
  if (!session) {
    return <div>Not authenticated</div>;
  }

  return <div>Welcome, {session.user.email}</div>;
}
```

### Protected Routes

```tsx
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function Dashboard() {
  const session = await auth();
  
  if (!session) {
    redirect("/login");
  }

  return <div>Dashboard content</div>;
}
```

### Login Form

```tsx
"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const [error, setError] = useState<string>();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid credentials");
      return;
    }

    router.push("/dashboard");
  };

  return (
    <form onSubmit={handleSubmit}>
      <input name="email" type="email" required />
      <input name="password" type="password" required />
      <button type="submit">Login</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
```

### Sign Out

```tsx
import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button onClick={() => signOut({ callbackUrl: "/" })}>
      Sign Out
    </button>
  );
}
```

## Components

### AuthProvider

Wraps the application to provide session context:

```tsx
// src/components/auth-provider.tsx
"use client";

import { SessionProvider } from "next-auth/react";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
```

### SignOutButton

Reusable sign-out button component:

```tsx
// src/components/sign-out-button.tsx
"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/" })}
      type="button"
    >
      Sign Out
    </button>
  );
}
```

## API Routes

### Authentication Endpoints

- `GET /api/auth/signin` - Sign in page
- `POST /api/auth/signin` - Sign in request
- `GET /api/auth/signout` - Sign out page
- `POST /api/auth/signout` - Sign out request
- `GET /api/auth/session` - Get current session
- `GET/POST /api/auth/callback/:provider` - OAuth callback

### Custom API Route

```typescript
// src/app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/lib/auth";

export const { GET, POST } = handlers;
```

## Customization

### Adding OAuth Provider

```typescript
import GoogleProvider from "next-auth/providers/google";

const authOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  // ...
};
```

### Database Session Strategy

```typescript
import { PrismaAdapter } from "@auth/prisma-adapter";

const authOptions = {
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "database",
  },
  // ...
};
```

### Custom JWT Claims

```typescript
callbacks: {
  async jwt({ token, user }) {
    if (user) {
      token.id = user.id;
      token.role = user.role;
    }
    return token;
  },
  async session({ session, token }) {
    if (session.user) {
      session.user.id = token.id as string;
      session.user.role = token.role as string;
    }
    return session;
  },
}
```

## Security Best Practices

1. **Use HTTPS in Production**
   - Always use HTTPS to protect authentication tokens
   - Set `NEXTAUTH_URL` to your production domain

2. **Secure Secret Management**
   - Use strong, random secrets
   - Never commit secrets to version control
   - Rotate secrets regularly

3. **Session Security**
   - Use JWT strategy for stateless sessions
   - Set appropriate session timeouts
   - Implement token refresh logic if needed

4. **Rate Limiting**
   - Implement rate limiting on login attempts
   - Prevent brute force attacks

5. **Input Validation**
   - Validate all user inputs
   - Sanitize email addresses
   - Check password strength

## Troubleshooting

### Common Issues

**Issue:** "Invalid CSRF token"
- **Solution:** Ensure `NEXTAUTH_URL` matches your application URL

**Issue:** "Missing secret"
- **Solution:** Set `NEXTAUTH_SECRET` environment variable

**Issue:** Session not persisting
- **Solution:** Check cookie settings and domain configuration

**Issue:** 404 on auth routes
- **Solution:** Ensure API route file is correctly structured

## Migration from v4

If migrating from NextAuth v4:

1. Update import paths: `next-auth/react` instead of `next-auth/react`
2. Use `handlers` pattern for API routes
3. Update session callback structure
4. Review breaking changes in v5 beta

## References

- [NextAuth.js Documentation](https://next-auth.js.org/)
- [NextAuth v5 Beta Docs](https://next-auth.js.org/beta)
- [Credentials Provider](https://next-auth.js.org/providers/credentials)
- [JWT Session Strategy](https://next-auth.js.org/configuration/options#session)
