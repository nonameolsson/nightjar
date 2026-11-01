# Tracker and Code host are two independent Adapters

A team can keep its work in an Azure DevOps board while its code lives in a GitHub repo, so the Tracker and the Code host are chosen separately, each with its own Adapter. We rejected one Adapter per platform because it would force every Tracker to pair with its own Code host and rule out that mix.
