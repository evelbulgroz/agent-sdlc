import { engineModule } from './primitives.ts';
import { admissionContracts } from './admission-types.ts';

export async function validateRegistrations(root: string, registrations: { adapterId: string }[]): Promise<{ adapterId: string; bindingHash: string }[]> {
  const contracts = await admissionContracts();
  const { verifyEvidenceRegistration } = await engineModule('host/evidence-files');
  for (const registration of registrations) {
    contracts.AdapterRegistrationSchema.parse(registration);
    verifyEvidenceRegistration(root, registration);
  }
  return registrations.map((registration) => ({
    adapterId: registration.adapterId, bindingHash: contracts.sha256(registration),
  }));
}
