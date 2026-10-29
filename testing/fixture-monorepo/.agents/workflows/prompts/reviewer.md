# Reviewer Addenda

- Verify architecture boundaries: UI -> application use case -> port -> gateway adapter, and controller -> application use case -> domain aggregate -> adapter.
- Frontend code must use the generated gateway client; PWA must never import @fixture/*-service packages or service /contracts. Inter-service contracts use @fixture/<service>-service/contracts.
- Flag unrequested user-visible text, styling changes, or duplicated derived state as P1 on added diff lines.
