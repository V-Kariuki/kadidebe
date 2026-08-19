import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200)
});

export const approveUserSchema = z.object({
  role: z.enum(['agent', 'coordinator', 'admin']),
  wardId: z.string().optional().nullable()
}).refine((data) => data.role !== 'agent' || !!data.wardId, {
  message: 'wardId is required when approving an agent',
  path: ['wardId']
});

export const stationResultSchema = z.object({
  votesCast: z.number().int().min(0).max(100000),
  status: z.enum(['pending', 'progress', 'done', 'flag'])
});

export const agentStatusSchema = z.object({
  status: z.enum(['active', 'idle'])
});

export const incidentCreateSchema = z.object({
  stationCode: z.string().max(20).optional().default(''),
  wardName: z.string().max(80).optional().default(''),
  note: z.string().min(3).max(2000),
  severity: z.enum(['low', 'high']).optional().default('low')
});

export const incidentUpdateSchema = z.object({
  status: z.enum(['open', 'resolved'])
});

export const constituencyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const constituencyUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const wardCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  registeredVoters: z.number().int().min(0).max(2000000).optional().default(0),
  constituencyId: z.string().min(1).optional().nullable()
});

export const wardUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  registeredVoters: z.number().int().min(0).max(2000000).optional(),
  constituencyId: z.string().min(1).optional().nullable()
});

export const stationCreateSchema = z.object({
  code: z.string().trim().min(1).max(30),
  wardId: z.string().min(1),
  registered: z.number().int().min(0).max(100000).optional().default(0)
});

export const stationUpdateSchema = z.object({
  code: z.string().trim().min(1).max(30).optional(),
  wardId: z.string().min(1).optional(),
  registered: z.number().int().min(0).max(100000).optional()
});

export const stationAssignSchema = z.object({
  agentId: z.string().min(1).nullable()
});

export const userAssignmentSchema = z.object({
  wardId: z.string().min(1).nullable()
});

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid input', details: result.error.flatten() });
    }
    req.body = result.data;
    next();
  };
}
