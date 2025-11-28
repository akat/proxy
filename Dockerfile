FROM node:18-alpine

WORKDIR /app
COPY expo_push_proxy.js ./

EXPOSE 8080
ENV PORT=8080 \
    MIN_INTERVAL_MS=20000 \
    STAGGER_MS=3000 \
    EXPO_ENDPOINT=https://exp.host/--/api/v2/push/send

CMD ["node", "expo_push_proxy.js"]
