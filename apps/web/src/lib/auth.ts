import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

const authOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials: any) {
        // TODO: Replace with actual authentication logic
        // This is a placeholder for demonstration
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        // Demo credentials for development
        if (
          credentials.email === "demo@example.com" &&
          credentials.password === "demo123"
        ) {
          return {
            id: "1",
            email: "demo@example.com",
            name: "Demo User",
          };
        }

        return null;
      },
    }),
  ],
  session: {
    strategy: "jwt" as const,
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }: any) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

export const { handlers, auth, signIn, signOut } = NextAuth(authOptions);
