variable "project_id" {
  description = "GCP project ID used in resource names (kinglet accepts any project in bypass mode)."
  type        = string
  default     = "kinglet-terraform-validation"
}

variable "region" {
  description = "Default region/location for regional resources."
  type        = string
  default     = "us-central1"
}

variable "kinglet_endpoint" {
  description = "Base HTTP URL for the running kinglet instance (no trailing slash)."
  type        = string
  default     = "http://127.0.0.1:8765"
}

variable "access_token" {
  description = "Dummy OAuth access token; kinglet does not validate credentials in bypass mode."
  type        = string
  default     = "dummy-access-token"
  sensitive   = true
}
