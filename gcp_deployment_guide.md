# GCP Deployment Guide for Forticheck Bot

This guide walks you through deploying the Forticheck Scanner Bots and Watchdog services to Google Cloud Platform (GCP) using a Google Compute Engine (GCE) VM instance and Docker Compose.

---

## Prerequisite: Provisioning the VM on GCP

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Navigate to **Compute Engine > VM instances** and click **Create Instance**.
3. Choose the configuration:
   - **Machine Type**: `e2-micro` (2 vCPUs, 1 GB RAM) or `e2-medium` (2 vCPUs, 4 GB RAM) is recommended.
   - **Boot Disk**: Choose **Ubuntu 22.04 LTS** or **Debian 11** with at least 15 GB disk space.
   - **Firewall**: Check both **Allow HTTP traffic** and **Allow HTTPS traffic** if you plan to host any web interfaces (otherwise, keep unchecked for security).
4. Click **Create** to launch the instance.

Alternatively, you can provision the VM using the `gcloud` CLI:
```bash
gcloud compute instances create forticheck-bot-vm \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --machine-type=e2-medium \
    --zone=us-central1-a
```

---

## Step 1: Install Docker & Docker Compose on the VM

SSH into your VM instance and execute the following commands to install Docker:

```bash
# Update package index
sudo apt-get update

# Install dependencies
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# Add Docker's official GPG key
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Set up the Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Enable and start Docker service
sudo systemctl enable docker
sudo systemctl start docker

# Add your user to the docker group (to run docker without sudo)
sudo usermod -aG docker $USER
```
*(Note: Log out and log back in for the docker group membership to take effect)*

---

## Step 2: Clone Repo and Configure Environment

1. Clone your project repository onto the VM:
   ```bash
   git clone <YOUR_REPOSITORY_URL> forticheck
   cd forticheck
   ```
2. Create the shared SQLite database directory:
   ```bash
   mkdir -p db
   ```
3. Create your production `.env` file:
   ```bash
   cp .env.example .env
   nano .env
   ```
4. Fill in all production configuration keys in `.env` (e.g. `DISCORD_TOKEN`, `SOLANA_RPC_URL`, `WHOP_API_KEY`, etc.). Ensure you define `DB_PATH` inside `.env` or let docker-compose set it:
   ```env
   DB_PATH=/app/db/whitelabel.db
   ```

---

## Step 3: Run the Application with Docker Compose

1. Build and launch all four container services in detached (background) mode:
   ```bash
   docker compose up -d --build
   ```
2. Verify that all containers are running successfully:
   ```bash
   docker compose ps
   ```

You should see all 4 containers listed as `Up`:
- `forticheck-solana-bot`
- `forticheck-bsc-bot`
- `forticheck-solana-watchdog`
- `forticheck-bsc-watchdog`

---

## Step 4: Monitoring and Troubleshooting

- **View Logs**: To inspect real-time console output for any specific container:
  ```bash
  docker compose logs -f solana-bot
  docker compose logs -f solana-watchdog
  ```
- **Inspect SQLite Database**: To view the status of active subscriptions, configs, or tracked tokens, you can run sqlite3 directly on the host VM:
  ```bash
  sqlite3 db/whitelabel.db "SELECT * FROM whitelabel_configs;"
  sqlite3 db/whitelabel.db "SELECT * FROM cto_watchlist;"
  ```
- **Restart Services**: If you make any code updates or change `.env`:
  ```bash
  docker compose restart
  ```
