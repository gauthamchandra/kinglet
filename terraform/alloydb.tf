resource "google_alloydb_cluster" "app_db" {
  provider   = google-beta
  cluster_id = "kinglet-validation-alloydb"
  location   = var.region

  network_config {
    network = "projects/${var.project_id}/global/networks/default"
  }

  initial_user {
    user     = "postgres"
    password = "kinglet-validation-postgres"
  }

  database_version = "POSTGRES_15"
  cluster_type     = "PRIMARY"

  automated_backup_policy {
    enabled = false

    time_based_retention {
      retention_period = "1209600s"
    }
  }

  continuous_backup_config {
    enabled = false
  }

  maintenance_update_policy {
    maintenance_windows {
      day = "SUNDAY"
      start_time {
        hours   = 3
        minutes = 0
        seconds = 0
        nanos   = 0
      }
    }
  }

  labels = {
    service = "kinglet-validation"
  }

  deletion_protection = false
}

resource "google_alloydb_instance" "primary" {
  provider          = google-beta
  cluster           = google_alloydb_cluster.app_db.name
  instance_id       = "kinglet-validation-primary"
  instance_type     = "PRIMARY"
  availability_type = "ZONAL"
  gce_zone          = "us-central1-a"

  machine_config {
    cpu_count    = 2
    machine_type = "n2-highmem-2"
  }

  database_flags = {
    "alloydb.iam_authentication"     = "on"
    "alloydb.logical_decoding"       = "on"
    "google_columnar_engine.enabled" = "off"
    "max_connections"                = "1000"
  }

  connection_pool_config {
    enabled = false
    flags   = {}
  }

  observability_config {
    enabled                 = true
    preserve_comments       = true
    track_wait_events       = true
    track_wait_event_types  = true
    track_active_queries    = true
    max_query_string_length = 4500
    record_application_tags = true
    query_plans_per_minute  = 5
  }

  labels = {
    role = "primary"
  }
}

resource "google_alloydb_instance" "read_pool" {
  provider      = google-beta
  cluster       = google_alloydb_cluster.app_db.name
  instance_id   = "kinglet-validation-read-pool"
  instance_type = "READ_POOL"

  read_pool_config {
    node_count = 1
  }

  machine_config {
    cpu_count    = 2
    machine_type = "n2-highmem-2"
  }

  database_flags = {
    "max_connections" = "1000"
  }

  connection_pool_config {
    enabled = false
    flags   = {}
  }

  observability_config {
    enabled                 = true
    preserve_comments       = true
    track_wait_events       = true
    track_wait_event_types  = true
    track_active_queries    = true
    max_query_string_length = 1024
    record_application_tags = true
    query_plans_per_minute  = 5
  }

  labels = {
    role = "read-replica"
  }

  depends_on = [google_alloydb_instance.primary]
}

resource "google_alloydb_user" "app_service" {
  cluster   = google_alloydb_cluster.app_db.name
  user_id   = "app_service"
  password  = "kinglet-validation-app"
  user_type = "ALLOYDB_BUILT_IN"

  depends_on = [google_alloydb_instance.primary]
}

resource "google_alloydb_user" "app_service_ro" {
  cluster        = google_alloydb_cluster.app_db.name
  user_id        = "app_service_ro"
  password       = "kinglet-validation-app-ro"
  user_type      = "ALLOYDB_BUILT_IN"
  database_roles = ["pg_read_all_data"]

  depends_on = [google_alloydb_instance.primary]
}

resource "google_alloydb_user" "migrations" {
  cluster   = google_alloydb_cluster.app_db.name
  user_id   = "migrations"
  password  = "kinglet-validation-migrations"
  user_type = "ALLOYDB_BUILT_IN"
  # Real AlloyDB returns roles alphabetically; sort() matches that GET order.
  database_roles = sort(["alloydbsuperuser", "pg_read_all_data", "pg_write_all_data"])

  depends_on = [google_alloydb_instance.primary]
}

resource "google_alloydb_user" "ai_agent" {
  cluster        = google_alloydb_cluster.app_db.name
  user_id        = "ai-agent@example.iam"
  user_type      = "ALLOYDB_IAM_USER"
  database_roles = sort(["ai_agents_rw", "alloydbiamuser"])

  depends_on = [google_alloydb_instance.primary]
}

resource "google_alloydb_backup" "on_demand" {
  provider     = google-beta
  location     = var.region
  backup_id    = "kinglet-validation-backup"
  cluster_name = google_alloydb_cluster.app_db.name
  type         = "ON_DEMAND"

  depends_on = [google_alloydb_instance.primary]
}
