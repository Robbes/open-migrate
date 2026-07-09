/**
 * Open Migration API Server
 * 
 * Express-based REST API for the managed edition.
 * Provides tenant management, migration control, and billing endpoints.
 */

import express from 'express';
import type { Request, Response, NextFunction, Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

// Import types
import type { AuthenticatedRequest, JwtPayload } from './types/api';

// Import routes
import webhookRoutes from './routes/trigger-webhook';
import tenantRoutes from './routes/tenants/index';
import mappingRoutes from './routes/migrations/index';
import billingRoutes from './routes/billing/index';
import billingWebhookRoutes from './routes/billing/webhooks';

// Re-export for backwards compatibility
export type { AuthenticatedRequest, JwtPayload };

// Configuration
const app: Application = express();
const PORT = process.env.API_PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3123',
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json());

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/webhooks', webhookRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/mappings', mappingRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/billing', billingWebhookRoutes);

// Error handling middleware
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error('API Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Start server
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

export { app };
export default app;
