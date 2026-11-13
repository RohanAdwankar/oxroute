import type {MetadataRoute} from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {name:"Oxroute",short_name:"Oxroute",start_url:"/",scope:"/",display:"standalone"};
}
