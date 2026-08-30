resource "google_workflows_workflow" "sample_pipeline" {
  name   = "kinglet-validation-sample-workflow"
  region = var.region

  deletion_protection = false

  source_contents = <<-EOF
    - assign:
        - result: "kinglet-terraform-validation"
    - return: $${result}
  EOF
}
