FROM node:18-alpine

WORKDIR /app

# Install server dependencies
COPY package*.json ./
RUN npm install

# Install client dependencies
COPY client/package*.json ./client/
RUN cd client && npm install

# Copy source and build
COPY . .
RUN cd client && npm run build

EXPOSE 5002
CMD ["node", "server/index.js"]
