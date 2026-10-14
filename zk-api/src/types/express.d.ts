import type { Partner } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      partner?: Partner;
      actorRef?: string | null;
      requestDigest?: string;
      grantedScope?: string;
      accessLogged?: boolean;
      accessResource?: { type: string; id: string | null };
    }
  }
}

export {};
