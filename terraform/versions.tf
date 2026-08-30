terraform {
  required_version = ">= 1.10.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.45.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  pubsub_custom_endpoint    = "${var.kinglet_endpoint}/v1/"
  kms_custom_endpoint       = "${var.kinglet_endpoint}/v1/"
  workflows_custom_endpoint = "${var.kinglet_endpoint}/v1/"

  # Avoid real oauth2.googleapis.com token exchange in CI/local harness runs.
  access_token = var.access_token
}
