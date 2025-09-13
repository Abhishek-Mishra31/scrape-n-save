# LinkedIn Profile Scraper

A Node.js/TypeScript application that scrapes LinkedIn profiles using Puppeteer with stealth capabilities.

## Features

- Scrapes LinkedIn profile data including work experience, education, projects, and skills
- Handles LinkedIn authentication via cookies
- Uses Puppeteer with stealth plugin to avoid detection
- Saves scraped data to JSON files
- RESTful API endpoints

## API Endpoints

- `POST /scrape` - Scrape a LinkedIn profile by URL
  ```json
  {
    "profileUrl": "https://linkedin.com/in/username"
  }
  ```

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` file with your LinkedIn credentials:
   ```
   PORT=3000
   LINKEDIN_EMAIL=your_email@example.com
   LINKEDIN_PASSWORD=your_password
   ```

3. Run in development mode:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   npm start
   ```

## Deployment on Render

### Method 1: Using Render Dashboard

1. **Prepare your repository:**
   - Push your code to GitHub
   - Ensure all files including `render.yaml` are committed

2. **Create a new Web Service on Render:**
   - Go to [Render Dashboard](https://dashboard.render.com)
   - Click "New" → "Web Service"
   - Connect your GitHub repository

3. **Configure the service:**
   - **Name:** linkedin-scraper (or your preferred name)
   - **Environment:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** Starter (or higher for better performance)

4. **Set Environment Variables:**
   - `NODE_ENV` = `production`
   - `LINKEDIN_EMAIL` = your LinkedIn email
   - `LINKEDIN_PASSWORD` = your LinkedIn password
   - `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` = `true`
   - `PUPPETEER_EXECUTABLE_PATH` = `/usr/bin/google-chrome-stable`

5. **Deploy:**
   - Click "Create Web Service"
   - Wait for the build and deployment to complete

### Method 2: Using render.yaml (Infrastructure as Code)

1. The included `render.yaml` file will automatically configure your service
2. Just add your LinkedIn credentials as environment variables in the Render dashboard
3. Render will use the configuration from `render.yaml`

## Important Notes for Render Deployment

### Puppeteer Configuration
- Render doesn't include Chrome by default, so we use the system Chrome
- The `PUPPETEER_EXECUTABLE_PATH` points to the system Chrome installation
- Additional Chrome flags are included for stability in containerized environments

### File System Considerations
- Scraped data and cookies are saved to the container's file system
- Files will be lost on container restarts (ephemeral storage)
- For persistent storage, consider using external storage services

### Performance Considerations
- LinkedIn scraping can be resource-intensive
- Consider using a higher-tier plan for better performance
- Be mindful of LinkedIn's rate limits and terms of service

### Security
- Never commit your `.env` file with real credentials
- Use Render's environment variables for sensitive data
- Be aware that LinkedIn scraping may violate their terms of service

## Troubleshooting

### Common Issues on Render:

1. **Puppeteer fails to launch:**
   - Ensure `PUPPETEER_EXECUTABLE_PATH` is set correctly
   - Check that all Chrome flags are included

2. **Memory issues:**
   - Consider upgrading to a higher-tier plan
   - Optimize Puppeteer configuration

3. **LinkedIn blocking requests:**
   - Check cookie validity
   - Implement delays between requests
   - Use different user agents

### Monitoring
- Check Render logs for debugging information
- Monitor memory and CPU usage
- Set up alerts for service availability

## Legal Disclaimer

This tool is for educational purposes only. Web scraping LinkedIn may violate their Terms of Service. Use responsibly and ensure compliance with applicable laws and LinkedIn's robots.txt and terms of service.
