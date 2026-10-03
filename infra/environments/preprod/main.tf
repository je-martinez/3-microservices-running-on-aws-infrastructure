locals {
  region  = "us-east-1"
  network = "3mrai-preprod_preprod-network"
}

module "label_net" {
  source      = "../../modules/label"
  environment = var.environment
  name        = "net"
}

module "networking" {
  source   = "../../modules/networking"
  context  = { id = module.label_net.id, tags = module.label_net.tags }
  vpc_cidr = var.vpc_cidr
  subnets = [
    { suffix = "a", cidr = "10.1.1.0/24", az = "us-east-1a" },
    { suffix = "b", cidr = "10.1.2.0/24", az = "us-east-1b" },
  ]
}
