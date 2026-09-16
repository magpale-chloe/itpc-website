FROM node:22-alpine

WORKDIR /app

COPY backend/package*.json ./backend/
RUN npm ci --prefix backend

COPY backend ./backend

WORKDIR /app/backend

EXPOSE 3000
CMD ["npm", "start"]
