#!/usr/bin/env python3
"""
Script to complete Stalwart setup programmatically.
This script simulates the setup wizard by making the correct HTTP requests.
"""

import requests
import time
import sys

BASE_URL = "http://localhost:8080"
SESSION = requests.Session()

def wait_for_server(timeout=60):
    """Wait for the server to be ready."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            resp = SESSION.get(BASE_URL, allow_redirects=False)
            if resp.status_code in [200, 302]:
                return True
        except requests.exceptions.ConnectionError:
            pass
        time.sleep(1)
    return False

def complete_setup(domain="dev.local", admin_user="admin", admin_password="admin_dev_pw"):
    """Complete the setup wizard."""
    # Step 1: GET the setup page to get any required tokens
    print("Getting setup page...")
    resp = SESSION.get(f"{BASE_URL}/setup", allow_redirects=True)
    print(f"Setup page status: {resp.status_code}")
    
    # Step 2: POST the setup form
    print("Submitting setup form...")
    data = {
        "domain": domain,
        "adminUser": admin_user,
        "adminPassword": admin_password,
    }
    resp = SESSION.post(
        f"{BASE_URL}/setup",
        data=data,
        allow_redirects=False
    )
    print(f"Setup submission status: {resp.status_code}")
    print(f"Response location: {resp.headers.get('location', 'N/A')}")
    
    # Check if setup was successful
    if resp.status_code == 302:
        print("Setup completed successfully!")
        return True
    else:
        print(f"Setup failed with status {resp.status_code}")
        return False

def main():
    print("Waiting for Stalwart server to be ready...")
    if not wait_for_server():
        print("Server not ready!")
        sys.exit(1)
    print("Server is ready!")
    
    print("Completing setup...")
    if complete_setup():
        print("Setup completed successfully!")
        sys.exit(0)
    else:
        print("Setup failed!")
        sys.exit(1)

if __name__ == "__main__":
    main()
