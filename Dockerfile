FROM node:22-alpine
WORKDIR /app
COPY server.js config.example.json ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
