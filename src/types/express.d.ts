import 'express';

declare global {
  namespace Express {
    interface Request {
      propertyId?: number;
      org?: {
        organizationUserId: number;
        organizationId: number;
        role: string;
      };
    }
  }
}
