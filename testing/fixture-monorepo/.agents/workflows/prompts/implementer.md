# Implementer Addenda

- Preserve clean architecture boundaries: UI -> application use case -> port -> gateway adapter, and controller -> application use case -> domain aggregate -> adapter.
- Frontend code must use the generated gateway client; PWA must never import @fixture/*-service packages or service /contracts. Inter-service contracts use @fixture/<service>-service/contracts.
- Enforce dual validation across DTO setters, entity setters, PATCH messages, overview/detail projections, the property-rule matrix, and OpenAPI schemas.
- Tests Travel with Behavior: include co-located test updates with every @ac AC-NN asserting test using expect(...) or assert.
