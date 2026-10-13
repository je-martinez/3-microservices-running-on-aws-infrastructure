import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("fetch", Path(__file__).with_name("fetch_aws_icons.py"))
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)

NAMES = [
    "Architecture-Group-Icons_07312026/AWS-Cloud-logo_32.svg",
    "__MACOSX/Architecture-Group-Icons_07312026/._AWS-Cloud-logo_32.svg",
    "Architecture-Group-Icons_07312026/Region_32.svg",
    "Resource-Icons_07312026/Res_General-Icons/Res_48_Light/Res_Users_48_Light.svg",
    "Resource-Icons_07312026/Res_General-Icons/Res_48_Dark/Res_Users_48_Dark.svg",
]


def test_package_url_is_found_in_page_html():
    html = '<a href="https://d1.awsstatic.com/x/Icon-package_07312026.abc.zip">Download</a>'
    assert fetch.find_package_url(html) == "https://d1.awsstatic.com/x/Icon-package_07312026.abc.zip"


def test_select_matches_wanted_files_and_skips_macos_metadata():
    picked = fetch.select(NAMES, {"aws-cloud": "AWS-Cloud-logo_32.svg"}, {"users": "Res_Users_48_Light.svg"})
    assert picked == {
        ("group", "aws-cloud"): "Architecture-Group-Icons_07312026/AWS-Cloud-logo_32.svg",
        ("generic", "users"): "Resource-Icons_07312026/Res_General-Icons/Res_48_Light/Res_Users_48_Light.svg",
    }


def test_select_raises_when_a_wanted_icon_is_missing():
    import pytest

    with pytest.raises(SystemExit, match="vpc"):
        fetch.select(NAMES, {"vpc": "Virtual-private-cloud-VPC_32.svg"}, {})


def test_fetches_the_ecs_and_load_balancer_resource_icons():
    assert fetch.GENERIC["ecs-task"] == "Res_Amazon-Elastic-Container-Service_Task_48.svg"
    assert fetch.GENERIC["ecs-service"] == "Res_Amazon-Elastic-Container-Service_Service_48.svg"
    assert fetch.GENERIC["alb"] == "Res_Elastic-Load-Balancing_Application-Load-Balancer_48.svg"


def test_select_finds_a_service_resource_icon_in_its_category_folder():
    names = ["Resource-Icons_07312026/Res_Containers/Res_Amazon-Elastic-Container-Service_Task_48.svg"]
    picked = fetch.select(names, {}, {"ecs-task": "Res_Amazon-Elastic-Container-Service_Task_48.svg"})
    assert picked == {("generic", "ecs-task"): names[0]}
