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
      adminUserId?: number;
      adminRole?: 'super_admin' | 'install_staff';
    }
  }
}
