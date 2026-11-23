FROM node:22-alpine
WORKDIR /app
COPY server.js config.example.json ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
# Run unprivileged. ./config must be writable by uid 1000 (the node user).
USER node
CMD ["node", "server.js"]
