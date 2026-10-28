terraform {
  required_providers {
    random = { source = "hashicorp/random", version = "3.9.1" }
    local  = { source = "hashicorp/local", version = "2.9.1" }
    null   = { source = "hashicorp/null", version = "3.3.2" }
  }
}

# The deployment's name. Already deployed: see terraform.tfstate.
resource "random_pet" "name" {
  length = var.pet_length
}

resource "local_file" "motd" {
  filename = "${path.module}/motd.txt"
  contents = "Welcome to ${random_pet.name.id}\n"
}

resource "null_resource" "ready" {
  triggers = {
    motd = local_file.motd.content_sha256
  }
  depends_on = [local_file.motds]
}

output "name" {
  value = random_pet.name.id
}
