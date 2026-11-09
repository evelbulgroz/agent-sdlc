import { engineModule } from './primitives.mjs';
import { engineContracts } from './contracts.mjs';

export async function validateRegistrations(root, registrations) {
  const contracts = await engineContracts();
  const { verifyEvidenceRegistration } = await engineModule('host/evidence-files');
  for (const registration of registrations) {
    contracts.AdapterRegistrationSchema.parse(registration);
    verifyEvidenceRegistration(root, registration);
  }
  return registrations.map((registration) => ({
    adapterId: registration.adapterId, bindingHash: contracts.sha256(registration),
  }));
}
