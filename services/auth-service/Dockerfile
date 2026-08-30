FROM node:20-alpine
WORKDIR /app
RUN mkdir -p /etc/ssl/certs && \
    wget --no-verbose https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -O /etc/ssl/certs/rds-ca-bundle.pem
COPY package*.json ./
RUN npm install
COPY . .
RUN chown -R node:node /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1
CMD ["npm", "start"]
