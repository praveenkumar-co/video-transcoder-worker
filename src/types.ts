export interface VideoJob{
    videoId : string ;
    s3Key : string ;
    bucket : string ;
}
export interface TranscodeProgress{
    videoId : string ;
    percentage : number ;
    currentTime : number ;
    totalDuration : number ;
}

export interface TranscodeOutput{
    masterPLaylistKey : string ; 
    resolutions : string[];
}
