# Use the official Node.js image as a base
FROM node:22

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Install PM2 globally
RUN npm install -g pm2

# Expose the port your app runs on
EXPOSE 3000

# Command to run the application using PM2
CMD ["pm2-runtime", "npm", "run", "start"]