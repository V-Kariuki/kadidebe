import { z } from 'zod';

const jurisdictionType = z.enum(['ward', 'constituency', 'county', 'national']);

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // Only needed when the same email exists in more than one instance.
  tenantSlug: z.string().trim().min(1).max(60).optional().nullable()
});

const slugField = z.string().trim().min(2).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and hyphens only');
const jurisdictionTypeField = z.enum(['national', 'county', 'constituency', 'ward']);

export const tenantCreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: slugField,
  jurisdictionType: jurisdictionTypeField,
  jurisdictionId: z.string().min(1).optional().nullable(),
  contactEmail: z.string().trim().email().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  modules: z.record(z.string(), z.boolean()).optional(),
  positionIds: z.array(z.string().min(1)).optional(),
  admin: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().min(7).max(20).optional().nullable(),
    password: z.string().min(8).max(200)
  }).optional()
}).refine((d) => d.jurisdictionType === 'national' || !!d.jurisdictionId, {
  message: 'A jurisdiction is required unless the instance is national',
  path: ['jurisdictionId']
});

export const tenantUpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  jurisdictionType: jurisdictionTypeField.optional(),
  jurisdictionId: z.string().min(1).optional().nullable(),
  status: z.enum(['active', 'suspended']).optional(),
  contactEmail: z.string().trim().email().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable()
});

export const tenantModulesSchema = z.object({
  modules: z.record(z.string(), z.boolean())
});

export const tenantPositionsSchema = z.object({
  positionIds: z.array(z.string().min(1))
});

// Self-service signup now also picks the role and jurisdiction being
// requested, plus a phone number. 'admin' is requestable but — enforced in
// jurisdiction.js's canApprove — only an existing admin can ever approve
// an admin request, never a coordinator. 'aspirant' is view-only and can
// pick any jurisdiction level, same as a coordinator.
export const registerSchema = z.object({
  tenantSlug: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(7).max(20),
  password: z.string().min(8).max(200),
  roleRequested: z.enum(['agent', 'coordinator', 'admin', 'aspirant']),
  jurisdictionType,
  jurisdictionId: z.string().min(1).nullable().optional()
}).refine((data) => data.roleRequested !== 'agent' || data.jurisdictionType === 'ward', {
  message: 'Agents must request a specific ward',
  path: ['jurisdictionType']
}).refine((data) => data.roleRequested !== 'admin' || data.jurisdictionType === 'national', {
  message: 'Admin is always a national-level role',
  path: ['jurisdictionType']
}).refine((data) => data.jurisdictionType === 'national' || !!data.jurisdictionId, {
  message: 'A specific jurisdiction is required unless requesting national scope',
  path: ['jurisdictionId']
});

export const approveUserSchema = z.object({
  role: z.enum(['agent', 'coordinator', 'admin', 'aspirant']),
  jurisdictionType: jurisdictionType.optional().nullable(),
  jurisdictionId: z.string().min(1).optional().nullable()
}).refine((data) => data.role === 'admin' || !!data.jurisdictionType, {
  message: 'jurisdictionType is required unless approving as admin',
  path: ['jurisdictionType']
}).refine((data) => data.role === 'agent' ? data.jurisdictionType === 'ward' : true, {
  message: 'Agents must be scoped to a ward',
  path: ['jurisdictionType']
}).refine((data) => (data.jurisdictionType && data.jurisdictionType !== 'national') ? !!data.jurisdictionId : true, {
  message: 'jurisdictionId is required unless national scope',
  path: ['jurisdictionId']
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200)
});

export const reassignJurisdictionSchema = z.object({
  jurisdictionType: jurisdictionType.optional(),
  jurisdictionId: z.string().min(1).nullable().optional()
});

export const agentStatusSchema = z.object({
  status: z.enum(['active', 'idle'])
});

export const countyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(20).optional().nullable()
});

export const countyUpdateSchema = countyCreateSchema.partial({ name: true });

export const constituencyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(20).optional().nullable(),
  countyId: z.string().min(1).optional().nullable()
});

export const constituencyUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  code: z.string().trim().min(1).max(20).optional().nullable(),
  countyId: z.string().min(1).optional().nullable()
});

export const wardCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(20).optional().nullable(),
  registeredVoters: z.number().int().min(0).max(2000000).optional().default(0),
  constituencyId: z.string().min(1).optional().nullable()
});

export const wardUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  code: z.string().trim().min(1).max(20).optional().nullable(),
  registeredVoters: z.number().int().min(0).max(2000000).optional(),
  constituencyId: z.string().min(1).optional().nullable()
});

export const stationCreateSchema = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  wardId: z.string().min(1),
  registered: z.number().int().min(0).max(100000).optional().default(0),
  gpsLat: z.number().min(-90).max(90).optional().nullable(),
  gpsLng: z.number().min(-180).max(180).optional().nullable()
});

export const stationUpdateSchema = z.object({
  code: z.string().trim().min(1).max(30).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  wardId: z.string().min(1).optional(),
  registered: z.number().int().min(0).max(100000).optional(),
  gpsLat: z.number().min(-90).max(90).optional().nullable(),
  gpsLng: z.number().min(-180).max(180).optional().nullable()
});

export const streamCreateSchema = z.object({
  label: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(30).optional().nullable(),
  registered: z.number().int().min(0).max(100000).optional().default(0)
});

export const streamAgentSchema = z.object({
  agentId: z.string().min(1)
});

export const gpsCapture = {
  gpsLat: z.number().min(-90).max(90).optional().nullable(),
  gpsLng: z.number().min(-180).max(180).optional().nullable()
};

export const processEventSchema = z.object({
  eventType: z.enum([
    'materials_dispatched', 'materials_arrived', 'agent_arrived', 'boxes_confirmed_empty',
    'polling_opened', 'polling_closed', 'counting_started', 'counting_completed',
    'results_declared', 'materials_departed', 'materials_arrived_tally_centre'
  ]),
  // Who is confirming this milestone — required, since it's a logged form
  // rather than an anonymous button click.
  recordedBy: z.string().trim().min(2, 'Enter the name of the person confirming this').max(120),
  details: z.record(z.string().max(60), z.string().trim().max(300)).optional().default({}),
  note: z.string().trim().max(500).optional().nullable(),
  ...gpsCapture
});

export const ballotBoxSchema = z.object({
  positionId: z.string().min(1),
  boxSerial: z.string().trim().min(1).max(60)
});

export const ballotBoxSealSchema = z.object({
  iebcSealSerial: z.string().trim().min(1).max(60),
  agentSealSerials: z.array(z.string().trim().min(1).max(60)).max(10).optional().default([])
});

export const ballotBoxClosingSealSchema = z.object({
  sealSerial: z.string().trim().min(1).max(60)
});

export const ballotBoxSealMatchSchema = z.object({
  sealsMatch: z.boolean(),
  note: z.string().trim().max(500).optional().nullable()
});

export const ballotBoxResealSchema = z.object({
  sealSerial: z.string().trim().min(1).max(60)
});

export const ballotBookletSchema = z.object({
  positionId: z.string().min(1),
  serialStart: z.string().trim().min(1).max(60),
  serialEnd: z.string().trim().min(1).max(60),
  quantity: z.coerce.number().int().min(0).max(100000)
});

export const turnoutUpdateSchema = z.object({
  votersProcessed: z.number().int().min(0).max(100000)
});

export const candidateVotesSchema = z.record(z.string().trim().min(1).max(160), z.number().int().min(0));

// Results arrive as multipart/form-data (photo evidence is required), so
// this schema validates the parsed/coerced body manually rather than via
// the generic `validate()` JSON middleware — see index.js. Ballot
// accounting follows IEBC's categories: every ballot taken out of the box
// is exactly one of valid (for a candidate), rejected, disputed, spoilt,
// or stray — total_cast is the agent's own count, checked server-side.
export const resultSubmitSchema = z.object({
  positionId: z.string().min(1),
  candidateVotes: candidateVotesSchema,
  rejectedVotes: z.coerce.number().int().min(0),
  disputedVotes: z.coerce.number().int().min(0).default(0),
  spoiltVotes: z.coerce.number().int().min(0).default(0),
  strayVotes: z.coerce.number().int().min(0).default(0),
  totalCast: z.coerce.number().int().min(0),
  remainingBallots: z.coerce.number().int().min(0),
  validVotes: z.coerce.number().int().min(0),
  formReference: z.string().trim().max(20).optional().nullable()
});

export const incidentCreateSchema = z.object({
  streamId: z.string().min(1).optional().nullable(),
  wardId: z.string().min(1).optional().nullable(),
  stationCode: z.string().max(20).optional().default(''),
  wardName: z.string().max(80).optional().default(''),
  note: z.string().min(3).max(2000),
  severity: z.enum(['low', 'high']).optional().default('low'),
  urgent: z.coerce.boolean().optional().default(false)
});

export const incidentResolveSchema = z.object({
  resolutionNote: z.string().trim().min(3).max(2000)
});

export const incidentEscalateSchema = z.object({
  escalatedToType: z.enum(['constituency', 'county', 'national']),
  escalatedToId: z.string().min(1).nullable().optional(),
  urgent: z.boolean().optional()
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
